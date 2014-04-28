var when            = require('when'),
    nodefn          = require('when/node/function'),
    pipeline        = require('when/pipeline'),
    _               = require('lodash'),
    child_process   = require('child_process'),
    request         = require('request'),
    fs              = require('fs-extra'),
    walker          = require('walker'),
    path            = require('path'),
    settings        = require('./settings'),
    config          = require('../config'),
    dataProvider    = require('../models');



// This error object is thrown when we encounter an error during static site generation that should result in a reject.
function StaticSiteGenError(code, message) {
    this.code = code;
    this.message = message;
}
StaticSiteGenError.prototype = new Error;

function Logger() {
    this.logger = [];
    this.push = function (value) {
        console.log(value);
        this.logger.push(value);
    };
}


// ## Static Site Backends
var backends = {};


// Git-based backend.
backends.git = function (backendConfig, logger) {
    this.config = backendConfig;
    this.logger = logger;

    // Create the options that we will use for executing git commands.
    var newEnvPath = (this.config.gitBinDir ? (this.config.gitBinDir + path.delimiter) : '') + process.env.path;
    this.gitProcessOptions = {
        cwd: this.config.workingDir,
        env: _.defaults({
            Path: newEnvPath
        }, process.env)
    };
};

// Execute a git command and return a promise.
backends.git.prototype.executeGitCommand = function (command) {
    var deferred = when.defer();

    this.logger.push('$ ' + command);
    child_process.exec(command, this.gitProcessOptions, function (err, stdout, stderr) {
        if (err === null) {
            deferred.resolve();
        } else {
            deferred.reject(err);
        }
    });

    return deferred.promise;
};

// Called before any generation begins.
backends.git.prototype.initialize = function () {
    var self = this;

    self.logger.push('Initializing git backend.');

    return pipeline([
        // Ensure the directory exists.
        function () { return nodefn.call(fs.mkdirs, self.config.workingDir) },
        // Get all of the files in the directory.
        function () { return nodefn.call(fs.readdir, self.config.workingDir) },
        // Remove all files in the directory other than the .git directory.
        function (files) {
            var fileRemovePromises = _(files).filter(function (file) {
                return file !== '.git';
            }).map(function (file) {
                var fullPath = path.join(self.config.workingDir, file);
                self.logger.push('Removing ' + fullPath);
                return nodefn.call(fs.remove, fullPath).then(function () {
                    self.logger.push('Removed ' + fullPath);
                });
            }).value();

            return fileRemovePromises.length ? when.all(fileRemovePromises) : when.resolve('');
        },
        // Check if the .git directory exists.
        function () {
            var deferred = when.defer();
            fs.exists(path.join(self.config.workingDir, '.git/'), function (dirExists) {
                deferred.resolve(dirExists);
            });
            return deferred.promise;
        },
        // If a .git directory doesn't exist we need to clone the repository.
        function (isRepo) {
            if (!isRepo) {
                var command = 'git clone --no-checkout "'
                    + self.config.remoteRepo + '" .';

                return self.executeGitCommand(command);
            } else {
                // Perform a fetch.
                return self.executeGitCommand('git fetch');
            }
        },
        // Checkout the appropriate branch.
        function () {
            return self.executeGitCommand('git checkout ' + self.config.branch);
        },
        // Pull the latest content.  We only allow fast forward merges here since we're not equiped to deal with
		// conflicts.
        function () {
            return self.executeGitCommand('git pull --ff-only');
        },
        function () {
            self.logger.push('Git backend initialization complete.');
        }
    ]);
}

backends.git.prototype.write = function (readStream, relTargetPath) {
    var self = this;

    // Create the full output path.
    var fullPath = path.join(this.config.workingDir, relTargetPath);
    
    self.logger.push('Git backend started writing ' + fullPath);

    return pipeline([        
        // Make sure the directories exist.
        function () {
            return nodefn.call(fs.mkdirs, path.dirname(fullPath));
        },
        // Stream the contents to the file.
        function () {
            var writeStream = fs.createWriteStream(fullPath);

            // Forward the pipe.  We have to manually call end because by the time we get here the read stream may have
			// already ended.
            readStream.pipe(writeStream, { end: false });

            var deferred = when.defer();

            writeStream.on('finish', function () {
                deferred.resolve();
            });

            // End the writer when we end.
            readStream.on('end', function () {
                writeStream.end();
            });

            writeStream.on('error', function (err) {
                deferred.reject(err);
            });

            readStream.on('error', function (err) {
                writeStream.end();
                deferred.reject(err);
            });

            return deferred.promise;
        },
        function () {
            self.logger.push('Git backend finished writing ' + fullPath);
        }
    ]);
}

backends.git.prototype.finalize = function () {
    var self = this;

    self.logger.push('Finializing git backend.');

    return pipeline([
        // Perform a full add on the working directory.
        function () {
            return self.executeGitCommand('git add -A');
        },
        // Commit the files.
        function () {
            return self.executeGitCommand('git commit -m "Updated pages."');
        },
        // Push the files.
        function () {
            return self.executeGitCommand('git push origin ' + self.config.branch + ':' + self.config.branch);
        },
        function () {
            self.logger.push('Git backend finalization complete.');
        }
    ]);
}


// Create the backend to be used for generation.  configData should be a copy of the site configuration in config.js.
function createBackend(staticSiteConfig, logger) {
    // Return an error if there is no backend specified.
    var backendConfig = staticSiteConfig.backend;
    if (!_.isPlainObject(backendConfig)) {
        throw new StaticSiteGenError(404, 'Unable to find valid static site backend configuration.');
    }

    // Return an error if there is no backend name specified.
    var backendName = backendConfig.name;
    if (!_.isString(backendName)) {
        throw new StaticSiteGenError(404, 'Unable to find valid static site backend name configuration.');
    }

    // Get the backend.
    var backendType = backends[backendName];
    if (_.isUndefined(backendType)) {
        throw new StaticSiteGenError(404, 'Unable to find static site backend with the name "' + backendName + '".');
    }

    // Create a new backend.
    return new backendType(backendConfig, logger);
}


// ## Static Site
staticsite = {

    generate: function generate() {
        // Cache the configuration so we only use a single instance for the rest of the site generation.
        var configData = config();

        // Get the base url that we use when requesting the pages.
        var baseUrl = 'http://' + configData.server.host + ':' + configData.server.port + '/';

        // Keep an array of log messages.
        var logger = new Logger();

        // Build the list of static content page mappings.
        var buildStaticContentPageMappings = function (baseUrl, staticContentConfig) {
            // Create a promise for each config entry.
            var promises = _.map(staticContentConfig, function (entry) {
                var deferred = when.defer();

                var results = [];

                walker(entry.sourceDir).on('file', function (filePath, stat) {
                    // Get the path relative to the source directory.
                    var relativePath = path.relative(entry.sourceDir, filePath);
                    var routePath = path.join(entry.routeRoot, relativePath);
                    results.push({
                        url: baseUrl + routePath.replace(/\\/g, '/'),
                        target: routePath
                    });
                }).on('error', function (err) {
                    deferred.reject(err);
                }).on('end', function () {
                    deferred.resolve(results);
                });

                return deferred.promise;
            });

            return when.all(promises).then(function (results) {
                return _.flatten(results);
            });
        };

        try {
            // Return an error if we don't have any static site config.
            var staticSiteConfig = configData.staticsite;
            if (!_.isPlainObject(staticSiteConfig)) {
                throw new StaticSiteGenError(404, 'Unable to find valid static site configuration.');
            }

            // Create the backend.
            var backend = createBackend(staticSiteConfig, logger);

            // Determine our static content paths.
            var staticContentPageMappingsPromise = settings.read('activeTheme').then(function (activeTheme) {
                // sourceDir: The path to the content on disk.  We use this to enumerate all of the files that we need to
                // copy.
                // 
                // routeRoot: The route that maps to the files.
                var staticContentConfig = [{
                    sourceDir: path.join(configData.paths.corePath, 'built', 'public'),
                    routeRoot: 'public'
                }, {
                    sourceDir: configData.paths.imagesPath,
                    routeRoot: configData.paths.imagesRelPath
                }, {
                    sourceDir: path.join(configData.paths.themePath, activeTheme.value, 'assets'),
                    routeRoot: 'assets'
                }];

                return buildStaticContentPageMappings(baseUrl, staticContentConfig);
            });

            // Run the generation pipeline.
            return pipeline([
                // Initialize the backend.
                function () { return backend.initialize(); },
                // Collect our input data.
                function () {
                    return when.join(
                        dataProvider.Post.findAll(),
                        settings.read('postsPerPage'),
                        staticContentPageMappingsPromise
                    );
                },
                // Generate the static site contents.
                function (values) {
                    // Extract the values.
                    var posts = values[0],
                        postPerPage = parseInt(values[1].value, 10),
                        staticPageMappings = values[2];

                    // Get only the published posts.
                    var publishedPosts = posts.filter(function (post) {
                        return post.get('status') === 'published';
                    });

                    // Get the unique tag slugs for published posts.
                    var tagSlugs = _(publishedPosts).map(function (post) {
                        return post.related('tags').map(function (tag) {
                            return tag.get('slug');
                        });
                    }).flatten().uniq().value();

                    // Get the post slugs for published posts.
                    var postSlugs = _(publishedPosts).map(function (post) {
                        return post.get('slug');
                    }).value();


                    // Calcuate the number of non-static pages so we know how many pagination pages we need to request.
                    var numNonStaticPages = _.filter(publishedPosts, function (post) {
                        return !post.get('page');
                    }).length;

                    // Get the pagination slugs.
                    var paginationSlugs = _.map(_.range(2, Math.ceil(numNonStaticPages / postPerPage) + 1), function (pageIndex) {
                        return pageIndex.toString();
                    });


                    // Create the full list of pages that we should generate directly.  This will result in an array of
                    // arrays, which each element of the outer array containing the path to the page.
                    // 
                    // We start with an empty array for the main page.
                    var pagePaths = [[]].concat(_.map(postSlugs, function (slug) {
                        return [slug];
                    })).concat(_.map(tagSlugs, function (slug) {
                        return ['tag', slug];
                    })).concat(_.map(paginationSlugs, function (slug) {
                        return ['page', slug];
                    }));

                    var pageMappings = [];

                    // Create the mappings for pages and tags.
                    Array.prototype.push.apply(pageMappings, _.map(pagePaths, function (pagePathArray) {
                        return {
                            url: baseUrl + _.map(pagePathArray, function (element) { return element + '/'; }).join(''),
                            target: _.flatten([pagePathArray, staticSiteConfig.indexPageFilename]).join('/')
                        };
                    }));

                    // Add a mapping for the rss feed.
                    pageMappings.push({
                        url: baseUrl + 'rss/',
                        target: 'rss/' + staticSiteConfig.rssPageFilename
                    });

                    // Add mappings for favicon.ico and robots.txt.
                    pageMappings.push({
                        url: baseUrl + 'favicon.ico',
                        target: 'favicon.ico'
                    });

                    pageMappings.push({
                        url: baseUrl + 'robots.txt',
                        target: 'robots.txt'
                    });

                    // Append the static page mappings.
                    Array.prototype.push.apply(pageMappings, staticPageMappings);
                    
                    // Create a function to request and write each page.
                    var requestFunctions = _.map(pageMappings, function (pathMapping) {
                        return function () {
                            logger.push('Requesting ' + pathMapping.url);
                            var requestStream = request(pathMapping.url);
                            return backend.write(requestStream, pathMapping.target);
                        };
                    });

                    // Wait for all of the requests to complete.
                    return pipeline(requestFunctions);
                },
                function () {
                    return backend.finalize();
                },
                function () {
                    return logger;
                }
            ]);
        }
        catch (exp) {
            // Ignore all errors that are not StaticSiteGenError.
            if (!(exp instanceof StaticSiteGenError)) {
                throw exp;
            }

            // Reject this call with the given code and message.
            return when.reject({ code: exp.code, message: exp.message });
        }
    }
};

module.exports = staticsite;