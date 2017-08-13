#!/usr/bin/env node
/*
 * ----------------------------------------------------------------------------
 * "THE BEER-WARE LICENSE" (Revision 42):
 * <daevid.preis@gmail.com> wrote this file. As long as you retain this notice
 * you can do whatever you want with this stuff. If we meet some day, and you
 * think this stuff is worth it, you can buy me a beer in return. Daevid Preis
 * ----------------------------------------------------------------------------
 */
'use strict';
require('colors');

let fs              = require('fs'),
    path            = require('path'),
    readline        = require('readline'),
    _               = require('lodash'),
    argv            = require('argv'),
    uuid            = require('uuid'),
    jsmediatags     = require('jsmediatags'),
    mp4TagReader    = require('jsmediatags/build2/MP4TagReader'),
    ffmpeg          = require('fluent-ffmpeg'),
    lwip            = require('lwip');


let fileIndex = 0,
    ws = null,
    progress = null,
    tpl = {},
    args = {},
    env = {
        ['page-title']: 'My Movies',
        thumbnailCache: './.thumbnail-cache/',
        width: 116,
        height: 170,
        'zoom-width': 200,
        'zoom-height': 300
    };


const SHORTCUTS = {
    'title': '©nam',
    'artist': '©ART',
    'album': '©alb',
    'year': '©day',
    'comment': '©cmt',
    'track': 'trkn',
    'genre': '©gen',
    'picture': 'covr',
    'lyrics': '©lyr',
    'composer': '©wrt'
};


class ExMP4TagReader extends mp4TagReader {
    _parseData(data, tagsToRead) {
        var tags = {};

        tagsToRead = this._expandShortcutTags(tagsToRead);
        this._readAtom(tags, data, 0, data.getSize(), tagsToRead);

        // create shortcuts for most common data.
        for (var name in SHORTCUTS) if (SHORTCUTS.hasOwnProperty(name)) {
            var tag = tags[SHORTCUTS[name]];
            if (tag) {
                if (name === 'track') {
                    tags[name] = tag.data.track;
                } else {
                    tags[name] = tag.data;
                }
            }
        }

        return {
            'type': 'MP4',
            'ftyp': data.getStringAt(8, 4),
            'version': data.getLongAt(12, true),
            'tags': tags
        };
    }
}


function print () {
    clearProgress();
    console.log.apply(null, arguments);
    if (progress)
        printProgress(progress.current, progress.total, true);
}

let printProgress = (current, total, noClear) => {
    let padLeft = (s, len) => {
        while (s.length < len)
            s = ` ${s}`;
        return s;
    };

    if (progress && !noClear)
        clearProgress();

    let indicator = progress && progress.indicator.length < 3
        ? progress.indicator += '.'
        : '';

    console.log(`Working${indicator} ${padLeft(String(Math.round(current / total * 100)), 6 - indicator.length)}%`);

    progress = {
        current:    current,
        total:      total,
        indicator:  indicator
    };
};

let clearProgress = (reset) => {
    if (progress) {
        if (reset)
            progress = false;
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
    }
};


/**
 * returns the name of this script.
 * @returns {string}
 */
let getScriptName = () => {
    if (process.argv && process.argv.length >= 2)
        return path.basename(process.argv[1]);
    return null;
};


/**
 * validate command line arguments and set defaults.
 * @returns {object}
 */
let processArguments = () => {

    argv
        .type('folder', (value) => {
            if (value === 'true')
                throw Error('Please specify a directory');
            if (!fs.existsSync(value))
                throw Error(`Directory ${value} not found`);
            return path.normalize(value);
        })
        .type('encoding', (value) => {
            if (!value || value === 'true')
                throw Error('Please specify an encoding');
            if (['ascii', 'utf8', 'utf16le', 'ucs2', 'base64', 'latin1', 'binary', 'hex'].indexOf(value.toLowerCase()) === -1)
                throw Error('Unknown encoding');
            return value.toLowerCase();
        })
        .type('size', (value) => {
            if (!value || value === 'true')
                throw Error('Please specify a size');

            let match = value.match(/^(\d+)x(\d+)$/i);
            if (match) {
                return {
                    width:  match[1],
                    height: match[2]
                };
            } else if (_.isArray(value) && value.length === 2 && !isNaN(value[0]) && !isNaN(value[1])) {
                return {
                    width:  value[0],
                    height: value[1]
                };
            }

            throw Error('Invalid size');
        })
        .type('env', (value) => {
            let match = value.match(/^(\w+),(.+)$/i);
            if (match) {
                let pair = {};
                pair[match[1]] = match[2];
                return pair;
            }
            throw Error('Invalid size');
        })
        .info(`Usage: ${getScriptName()} --directory=path [options]`);

    let args = argv.option([
        {
            name:           'directory',
            'short':        'd',
            type:           'folder',
            description:    'The directory to parse, mandatory.',
            example:        '--directory=/home/movies or -d /home/movies'
        }, {
            name:           'file',
            'short':        'f',
            type:           'string',
            description:    'Output file, default ./movie-shelf.html',
            example:        '--file=/home/my-movies.html or -f /home/my-movies.html'
        }, {
            name:           'folder-last',
            type:           'bool',
            description:    'Files first'
        }, {
            name:           'no-recursive',
            type:           'bool',
            description:    'Don\'t process sub folder.'
        }, {
            name:           'templates',
            type:           'path',
            description:    'Path to the templates, default ./templates',
            example:        '--templates=./templates'
        }, {
            name:           'extensions',
            type:           'csv,string',
            description:    'File extensions considered as movies, default mp4,avi,xvid,flv,mpeg',
            example:        '--extensions=mp4,avi'
        }, {
            name:           'encoding',
            type:           'encoding',
            description:    'Character encoding, default utf8',
            example:        '--encoding=utf8'
        }, {
            name:           'page-title',
            type:           'string',
            description:    'The page title... duh',
            example:        '--page-title="My Movies"'
        }, {
            name:           'cover-strategy',
            type:           'csv,string',
            description:    'How to generate thumbnails.',
            example:        '--cover-strategy=tag,image,ffmpeg,folder'
        }, {
            name:           'thumbnail-time',
            type:           'string',
            description:    'Time offset for thumbnails. Percentage or seconds',
            example:        '--thumbnail-time=30% or --thumbnail-time=120'
        }, {
            name:           'size',
            type:           'size',
            description:    'Thumbnail size in pixel.',
            example:        '--size=200x350'
        }, {
            name:           'zoom',
            type:           'size',
            description:    'Thumbnail size if zoomed in pixel, default --size * 2',
            example:        '--zoom=400x600'
        }, {
            name:           'quality',
            type:           'int',
            description:    'JPEG quality of resized images.',
            example:        '--quality=30'
        }, {
            name:           'no-resize',
            type:           'bool',
            description:    'Images won\'t be resized.'
        }, {
            name:           'keep-thumbnails',
            type:           'bool',
            description:    'Do not delete the thumbnail cache.'
        }, {
            name:           'filter',
            type:           'list,string',
            description:    'Regular expression to filter files. Applies to the full path.\n\t\t' +
                            'Multiple filters are combined with OR.\n\t\t' +
                            'To negate a filter use a regex like ^((?!asterix).)*$',
            example:        '--filter=asterix --filter=\'^((?!obelix).)*$\''
        }, {
            name:           'env',
            type:           'list,env',
            description:    'Additional key value pairs for templates.',
            example:        '--env=foo,bar --env=one,more'
        }, {
            name:           'ffmpeg',
            type:           'path',
            description:    'Path to ffmpeg executable. Use if ffmpeg is not in your PATH.',
            example:        '--ffmpeg=/bin/ffmpeg'
        }, {
            name:           'ffprobe',
            type:           'path',
            description:    'Path to ffprobe executable. Use if ffprobe is not in your PATH.',
            example:        '--ffmpeg=/bin/ffprobe'
        }
    ]).run().options;


    if (args.extensions)
        args.extensions = _.map(args.extensions, (x) => {
            if (x)
                return (x[0] === '.' ? '' : '.') + x.toLowerCase();
            return null;
        });

    if (args['cover-strategy'])
        args.coverStrategy = _.map(args['cover-strategy'], (x) => {
            return x ? x.toLowerCase() : null;
        });

    if (args['thumbnail-time'])
        args.thumbnailTime = args['thumbnail-time'];

    if (args['keep-thumbnails'])
        args.keepThumbnails = args['keep-thumbnails'];

    if (args['no-resize'])
        args.noResize = args['no-resize'];

    if (args['no-recursive'])
        args.noRecursive = args['no-recursive'];

    if (args['folder-last'])
        args.folderLast = args['folder-last'];

    if (args.ffmpeg)
        ffmpeg.setFfmpegPath(args.ffmpeg);

    if (args.ffprobe)
        ffmpeg.setFfprobePath(args.ffprobe);

    if (args.size)
        env = _.extend(env, args.size);

    if (args['page-title'])
        env['page-title'] = args['page-title'];

    if (args.zoom) {
        env['zoom-width'] = args.zoom.width;
        env['zoom-height'] = args.zoom.height;
    } else {
        env['zoom-width'] = env.width * 2;
        env['zoom-height'] = env.height * 2;
    }

    if (args.env)
        env = _.extend(_.fromPairs(_.map(args.env, (x) => {
            return [_.keys(x)[0], x[_.keys(x)[0]]];
        })), env);

    if (!args.directory) {
        argv.help();
        return null;
    }

    return _.extend({
        eval:           true,
        filter:         null,
        noResize:       false,
        quality:        30,
        file:           'movie-shelf.html',
        folderLast:     false,
        noRecursive:    false,
        templates:      path.normalize('./templates'),
        encoding:       'utf8',
        extensions:     ['.mp4', '.avi', '.xvid', '.flv', 'mpeg'],
        coverStrategy:  ['tag', 'image', 'ffmpeg', 'folder'],
        coverNames:     ['cover', 'thumbnail'],
        validImages:    ['jpg', 'jpeg', 'png', 'gif'],
        thumbnailTime: '30%',
        keepThumbnails: false
    }, args);
};



/**
 * delete folder recursive.
 * @returns {void}
 * @param location {string} folder to remove
 */
let deleteFolder = function (location) {
    if (fs.existsSync(location)) {
        _.each(fs.readdirSync(location), (file) => {
            var currentPath = path.join(location, file);
            if (fs.lstatSync(currentPath).isDirectory())
                deleteFolder(currentPath);
            else
                fs.unlinkSync(currentPath);
        });
        fs.rmdirSync(location);
    }
};

/**
 * determines if the file is a movie. using its extension
 * @returns {boolean}
 * @param file {string} the filename
 */
let isMovieFile = (file) => {
    return args.extensions.indexOf(path.extname(file).toLowerCase()) !== -1;
};

/**
 * determines if the file is an image. using its extension
 * @returns {boolean}
 * @param file {string} the filename
 */
let isImageFile = (file) => {
    return args.validImages.indexOf(path.extname(file).toLowerCase().substr(1)) !== -1;
};

/**
 * read the mp4 tag of a file.
 * @returns {Promise}
 * @param file {string} path to the file
 */
let readTag = (file) => {
    return new Promise((resolve, reject) => {
        new jsmediatags.Reader(file)
            .setTagReader(ExMP4TagReader)
            .read({
                onSuccess: function (tag) {
                    if (tag && tag.tags)
                        resolve(tag.tags);
                    else
                        reject();
                },
                onError: function (err) {
                    reject(err);
                }
            });
    });
};


/**
 * resize an image and convert to jpg.
 * @returns {Promise}
 * @param data {Buffer} image data
 * @param format {string} the image format
 */
let resizeImage = (data, format) => {
    return new Promise((resolve) => {
        let res = {
            format: format,
            data:   data
        };

        if (data && !args.noResize) {
            lwip.open(data, format || 'jpg', (err, image) => {
                if (err)
                    resolve(res);
                else if (image) {
                    let maxWidth = env['zoom-width'],
                        maxHeight = env['zoom-height'],
                        newWidth = image.width(),
                        newHeight = image.height();

                    if (newWidth > maxWidth || newHeight > maxHeight) {
                        if (image.width() > image.height()) {
                            newWidth = maxWidth;
                            newHeight = image.height() * (maxWidth / image.width());
                        } else {
                            newWidth = image.width() * (maxHeight / image.height());
                            newHeight = maxHeight;
                        }
                    }

                    image
                        .batch()
                        .resize(newWidth, newHeight)
                        .toBuffer('jpg', {
                            quality: args.quality
                        }, (err, resized) => {
                            if (err)
                                resolve(res);
                            else
                                resolve({
                                    format: 'jpg',
                                    data:   resized
                                });
                        });
                } else
                    resolve(res);
            });
        } else
            resolve(res);
    });
};

/**
 * resize the image and get the base64 src data string.
 * @returns {Promise}
 * @param buffer {Buffer} buffer with image data
 * @param format {string} input format
 */
let getResizedBase64ImageFromBuffer = (buffer, format) => {
    return new Promise((resolve) => {
        resizeImage(buffer, format)
            .then((image) => {
                if (image) {
                    resolve(`data:image/${image.format};base64,${image.data.toString('base64')}`);
                } else
                    resolve();
            });
    });
};

/**
 * resize the image and get the base64 src data string.
 * @returns {Promise}
 * @param file {string} path to the file
 */
let getResizedBase64ImageFromFile = (file) => {
    let getImageFormat = () => {
        switch (path.extname(file).toLowerCase()) {
            case '.jpeg':
                return 'jpg';
            default:
                return path.extname(file).substr(1).toLowerCase();
        }
    };
    if (fs.existsSync(file))
        return getResizedBase64ImageFromBuffer(fs.readFileSync(file), getImageFormat());
    return Promise.resolve(null);
};



let createFileMap = (directory) => {
    let directoryContent = fs.readdirSync(directory),
        folder = {
            path:   path.normalize(`${directory}/`),
            name:   path.basename(directory),
            id:     uuid(),
            files:  [],
            subs:   [],
            total:  0
        };

    let isCoverFile = (x) => {
        let re = RegExp(`(?:${args.coverNames.join('|')})\\.(?:${args.validImages.join('|')})`, 'i');
        return !!x.match(re);
    };

    let filterApplies = (path) => {
        if (!_.isEmpty(args.filter))
            return path.match(RegExp(`(?:${args.filter.join(')(')})`, 'gi'));
        return true;
    };

    if (directoryContent && directoryContent.length) {
        _.each(directoryContent, (x) => {
            let fullpath = path.join(directory, x),
                stats = fs.statSync(fullpath);

            if (stats.isDirectory() && !args.noRecursive) {
                let subFolder = createFileMap(fullpath);
                if (subFolder) {
                    folder.subs.push(subFolder);
                    folder.total += subFolder.total;
                }
            }

            else if (stats.isFile() && isMovieFile(fullpath) && filterApplies(fullpath)) {
                // search for name.jpg .png ....
                let coverFile = _.find(directoryContent, (file) => {
                    if (isImageFile(file)) {
                        let imgName = file.replace(path.extname(file), '').toLowerCase().trim();
                        let fileName = x.replace(path.extname(x), '').toLowerCase().trim();
                        return imgName === fileName || imgName === x.toLowerCase().trim();
                    }
                    return false;
                }) || null;

                folder.files.push({
                    id:         uuid(),
                    name:       x,
                    path:       fullpath,
                    coverFile:  coverFile ? path.join(directory, coverFile) : null
                });
            }

            else if (!folder.cover && stats.isFile() && isCoverFile(x)) {
                folder.cover = fullpath;
            }
        });

        folder.total += folder.files.length;

        if (folder.files.length || folder.subs.length) {
            folder.subs = _.sortBy(folder.subs, (x) => {
                return x.path.toLowerCase();
            });

            folder.files = _.sortBy(folder.files, (x) => {
                return x.name.toLowerCase();
            });

            return folder;
        }
    }
    return null;
};




let writeFileInfo = (folder, file) => {
    return new Promise((resolve) => {

        let getCoverArt = (fileInfo) => {
            return new Promise((resolve) => {

                let getCoverFromTag = () => {
                    return new Promise((resolve, reject) => {
                        if (fileInfo && fileInfo.image)
                            resolve(fileInfo.image);
                        else
                            reject();
                    });
                };

                let getCoverFromImage = () => {
                    return new Promise((resolve, reject) => {
                        if (file.coverFile) {
                            getResizedBase64ImageFromFile(file.coverFile)
                                .then((cover) => {
                                    if (cover)
                                        resolve(cover);
                                    else
                                        reject();
                                });
                        } else
                            reject();
                    });
                };

                let getCoverFromFolder = () => {
                    return new Promise((resolve, reject) => {
                        if (folder.cover)
                            getResizedBase64ImageFromFile(folder.cover)
                                .then((cover) => {
                                    if (cover)
                                        resolve(cover);
                                    else
                                        reject();
                                });
                        else
                            reject();
                    });
                };

                let getCoverFromThumbnail = () => {
                    return new Promise((resolve, reject) => {
                        let filename = `${env.thumbnailCache}${file.name}.png`;

                        let resizeAndRemove = (filename) => {
                            return new Promise((resolve, reject) => {
                                getResizedBase64ImageFromFile(filename)
                                    .then((cover) => {
                                        if (!args.keepThumbnails && fs.existsSync(filename))
                                            fs.unlinkSync(filename);

                                        if (cover)
                                            resolve(cover);
                                        else
                                            reject();
                                    });
                            });
                        };

                        new ffmpeg(file.path)
                            .on('filenames', () => {
                                print('generating thumbnail for:'.cyan, file.name.yellow);
                            })
                            .on('end', () => {
                                resizeAndRemove(filename)
                                    .then(resolve, () => {
                                        // try again at 0 seconds
                                        new ffmpeg(file.path)
                                            .on('end', () => {
                                                resizeAndRemove(filename)
                                                    .then(resolve, reject);
                                            })
                                            .on('error', () => {
                                                if (fs.existsSync(filename))
                                                    fs.unlinkSync(filename);
                                                reject();
                                            })
                                            .screenshots({
                                                count:      1,
                                                timemarks:  [0],
                                                folder:     env.thumbnailCache,
                                                filename:   `${file.name}.png`
                                            });
                                    });
                            })
                            .on('error', () => {
                                if (fs.existsSync(filename))
                                    fs.unlinkSync(filename);
                                reject();
                            })
                            // .on('stderr', (err) => {
                            //     print(err);
                            // })
                            // .on('start', function(commandLine) {
                            //     print('spawned ffmpeg with command: ' + commandLine);
                            // })
                            .screenshots({
                                count:      1,
                                timemarks:  [args.thumbnailTime],
                                folder:     env.thumbnailCache,
                                filename:   `${file.name}.png`
                            });
                    });
                };

                let strategy = _.map(args.coverStrategy, (x) => {
                    switch (x) {
                        case 'tag':
                            return getCoverFromTag;
                        case 'folder':
                            return getCoverFromFolder;
                        case 'image':
                            return getCoverFromImage;
                        case 'ffmpeg':
                            return getCoverFromThumbnail;
                        default:
                            return Promise.reject();
                    }
                });

                let executeStrategy = (index) => {
                    return new Promise((resolve) => {
                        strategy[index]()
                            .then(resolve, () => {
                                if (index < strategy.length - 1)
                                    executeStrategy(index + 1)
                                        .then(resolve);
                                else
                                    resolve();
                            });
                    });
                };

                executeStrategy(0)
                    .then((image) => {
                        fileInfo.cover = image ? tpl.cover : '';
                        fileInfo.image = image;
                        resolve();
                    });
            });
        };

        let getFileInfo = (tags) => {
            let fileInfo = _.extend(tags || {}, {
                id:             file.id,
                'parent-id':    folder.id,
                file:           file.name,
                path:           file.path,
                type:           path.extname(file.name).substr(1).toUpperCase(),
                title:          tags && tags.title ? tags.title : file.name.replace(path.extname(file.name), ''),
                cover:          tags && tags.picture ? tpl.cover : '',
                image:          tags && tags.picture
                                    ? getResizedBase64ImageFromBuffer(new Buffer(tags.picture.data), tags.picture.format.replace('image/', ''))
                                    : '',
                size:           '',
                duration:       '',
                date:           '',
                streams:        ''
            });

            ffmpeg.ffprobe(file.path, function (err, metadata) {
                if (metadata && metadata.format) {
                    fileInfo = _.extend(fileInfo, {
                        size:       metadata.format.size,
                        duration:   metadata.format.duration,
                        date:       metadata.format.tags && metadata.format.tags.creation_time ? metadata.format.tags.creation_time : ''
                    });

                    let getFrameRate = (rate) => {
                        if (rate) {
                            let match = rate.match(RegExp(RegExp('^\\s*(\\d+)\\s*(?:/\\s*(\\d+)\\s*)?$')));
                            if (match && match.length === 3)
                                return match[2]
                                    ? Math.round(match[1] / match[2] * 100) / 100
                                    : match[1];
                        }
                        return 0;
                    };

                    if (metadata.format.nb_streams) {
                        for (var i = 0, x = 0; i < metadata.format.nb_streams; i++) {
                            var stream = metadata.streams[i];
                            if (stream.codec_type.toUpperCase() !== 'VIDEO' || stream.codec_name !== 'mjpeg') {

                                fileInfo.streams +=
                                    `;Stream: ${++x};` +
                                    `Type: ${_.capitalize(stream.codec_type)};` +
                                    `Codec: ${stream.codec_long_name};`;

                                if (stream.codec_type.toUpperCase() === 'VIDEO') {
                                    fileInfo.streams +=
                                        `Resolution: ${stream.width}x${stream.height};` +
                                        `Aspect Ratio: ${stream.display_aspect_ratio};` +
                                        `Frame rate: ${getFrameRate(stream.avg_frame_rate)};`;
                                }

                                else if (stream.codec_type.toUpperCase() === 'AUDIO') {
                                    fileInfo.streams +=
                                        `Channels: ${stream.channels};` +
                                        `Mode: ${_.capitalize(stream.channel_layout)};` +
                                        `Sample Rate: ${stream.sample_rate} hz;` +
                                        `Bit Rate: ${Math.round(stream.bit_rate / 1000)} kb/s;`;
                                }

                            }
                        }
                    }
                }

                getCoverArt(fileInfo)
                    .then(() => {
                        ws.write(parseTemplate(tpl.file, fileInfo), args.encoding, () => {
                            resolve();
                        });
                    });
            });
        };

        readTag(file.path)
            .then((tags) => {
                getFileInfo(tags);
            }, () => {
                getFileInfo();
            });
    });
};


let processFolder = (folder, parent, totalFiles) => {
    return new Promise((resolve) => {
        print('processing folder'.cyan, folder.path.green);

        let processSubFolder = (subFolder, index) => {
            return new Promise((resolve) => {
                if (subFolder && subFolder.length) {
                    processFolder(subFolder[index], folder, totalFiles)
                        .then(() => {
                            if (index < subFolder.length - 1) {
                                processSubFolder(subFolder, index + 1)
                                    .then(resolve);
                            } else {
                                resolve();
                            }
                        });
                }
            });
        };

        let processFiles = () => {
            return new Promise((resolve) => {

                let processFile = (index) => {
                    return new Promise((resolve) => {

                        let nextFileOrContinue = () => {
                            if (index < folder.files.length - 1) {
                                processFile(index + 1)
                                    .then(resolve);
                            } else if (folder.subs.length && args.folderLast) {
                                processSubFolder(folder.subs, 0)
                                    .then(resolve);
                            } else {
                                resolve();
                            }
                        };

                        if (!args.folderLast && index === 0 && folder.subs.length) {
                            processSubFolder(folder.subs, 0)
                                .then(() => {
                                    if (folder.files.length && index < folder.files.length) {
                                        let file = folder.files[index];
                                        print('processing file:'.cyan, file.name.yellow);
                                        printProgress(++fileIndex, totalFiles);
                                        writeFileInfo(folder, file)
                                            .then(nextFileOrContinue);
                                    } else
                                        nextFileOrContinue();
                                });
                        } else if (folder.files.length && index < folder.files.length) {
                            let file = folder.files[index];
                            print('processing file:'.cyan, file.name.yellow);
                            printProgress(++fileIndex, totalFiles);
                            writeFileInfo(folder, file)
                                .then(nextFileOrContinue);
                        } else {
                            nextFileOrContinue();
                        }
                    });
                };

                processFile(0)
                    .then(resolve);
            });
        };

        if (folder.files.length || folder.subs.length) {
            if (parent) {
                let itemCount = folder.subs.length + folder.files.length,
                    folderName = `${folder.name} (${itemCount} Item${(itemCount > 1 ? 's' : '')})`;

                getResizedBase64ImageFromFile(folder.cover)
                    .then((cover) => {
                        ws.write(parseTemplate(tpl.folderStart, {
                            id:             folder.id,
                            'parent-id':    parent.id,
                            folder:         folderName,
                            cover:          cover ? tpl.cover : '',
                            image:          cover
                        }), args.encoding, () => {
                            processFiles()
                                .then(() => {
                                    ws.write(parseTemplate(tpl.folderEnd, {
                                        id:             folder.id,
                                        'parent-id':    parent.id,
                                        folder:         folderName,
                                        cover:          cover ? tpl.cover : '',
                                        image:          cover
                                    }), args.encoding, resolve);
                                });
                        });
                    });
            } else {
                processFiles()
                    .then(resolve);
            }
        } else {
            resolve();
        }
    });
};



/**
 * read the template files.
 * @returns {object}
 */
let readTemplates = () => {
    return {
        header:         fs.readFileSync(path.join(args.templates, 'header.tpl.html'), args.encoding),
        folderStart:    fs.readFileSync(path.join(args.templates, 'folder-start.tpl.html'), args.encoding),
        file:           fs.readFileSync(path.join(args.templates, 'file.tpl.html'), args.encoding),
        cover:          fs.readFileSync(path.join(args.templates, 'cover.tpl.html'), args.encoding),
        folderEnd:      fs.readFileSync(path.join(args.templates, 'folder-end.tpl.html'), args.encoding),
        footer:         fs.readFileSync(path.join(args.templates, 'footer.tpl.html'), args.encoding)
    };
};

/**
 * parse a template.
 * @returns {string}
 * @param template {string} the template
 * @param patterns {object} object with keys and values to search and replace
 */
let parseTemplate = (template, patterns) => {
    _.each(_.extend(patterns || {}, env) || {}, (value, key) => {
        let re = RegExp(`<#\\s*${key}\\s*#>`, 'gi');
        template = template.replace(re, value === undefined || value === null ? '' : value);
    });
    return template.replace(/<#.+#>/gi, '');
};




if ((args = processArguments()) !== null) {
    ws = fs.createWriteStream(args.file);
    tpl = readTemplates();

    let fileMap = createFileMap(args.directory);
    if (fileMap) {
        print('Found'.red, fileMap.total, 'file(s)'.red);
        env.files = fileMap.total;
        ws.write(parseTemplate(tpl.header), args.encoding, () => {
            processFolder(fileMap, null, fileMap.total)
                .then(() => {
                    if (!args.keepThumbnails)
                        deleteFolder(env.thumbnailCache);
                    print('finished...'.green);
                    clearProgress(true);
                    ws.write(parseTemplate(tpl.footer), args.encoding, () => {
                        ws.close();
                    });
                });
        });
    } else
        print('No files found...'.red);
}

