var when               = require('when'),
    nodefn             = require('when/node/function'),
    _                  = require('lodash'),   
    request            = require('request'),
    fs                 = require('fs-extra'),
    path               = require('path'),
    settings           = require('./settings'),
    config             = require('../config'),
    dataProvider       = require('../models');



function createUrl(config, pathArray) {
    return config.baseUrl + _.map(pathArray, function (element) { return element + '/'; }).join('');
}

function createFilePath(config, directoryArray, filename) {
    // If the filename isn't specified then we default to the index.
    filename = filename || config.indexFilename;
    return path.join.apply(path, _.flatten([config.targetDirectory, directoryArray, filename]));
}

// Request the given page and write it to the given file.
function requestAndWritePage(url, filename) {
    return nodefn.call(request, url).then(function (result) {
        var resultBody = result[1];

        // Create the directory then write the file.
        return nodefn.call(fs.mkdirs, path.dirname(filename)).then(function () {
            return nodefn.call(fs.writeFile, filename, resultBody);
        });
    });
}


// ## Static Site
staticsite = {

    generate: function generate() {
        var staticSiteConfig = {
            targetDirectory: 'R:/staticsite',
            indexFilename: 'index.html',
            rssFilename: 'rss.xml',
            baseUrl: 'http://localhost:2368/'
        };

        // Collect all necessary data.
        return when.join(
            dataProvider.Post.findAll(),
            settings.read('activeTheme'),
            settings.read('postsPerPage')
        ).then(function (values) {
            // Remove the existing static site.
            return nodefn.call(fs.remove, staticSiteConfig.targetDirectory).then(function () {
                // Forward on the values.
                return values;
            });
        }).then(function (values) {
            // Extract the values.
            var posts = values[0],
                activeTheme = values[1].value,
                postPerPage = parseInt(values[2].value, 10);
            
            // Cache the configuration so we only use a single instance for the rest of the site generation.
            var configData = config();

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

            // Create the full list of pages that we should generate directly.  This will result in an array of
            // arrays, which each element of the outer array containing the path to the page.
            // 
            // We start with an empty array for the main page.
            var pagePaths = [[]].concat(_.map(postSlugs, function (slug) {
                return [slug];
            })).concat(_.map(tagSlugs, function (slug) {
                return ['tag', slug];
            })).concat(_.map(_.range(2, Math.ceil(numNonStaticPages / postPerPage)), function (pageIndex) {
                return ['page', pageIndex.toString()];
            }));

            // Create the mappings for pages and tags.
            var pageMappings = _.map(pagePaths, function (pagePathArray) {
                return {
                    url: createUrl(staticSiteConfig, pagePathArray),
                    file: createFilePath(staticSiteConfig, pagePathArray)
                };
            });

            // Add a mapping for the rss feed.
            pageMappings.push({
                url: staticSiteConfig.baseUrl + 'rss/',
                file: path.join(staticSiteConfig.targetDirectory, 'rss', staticSiteConfig.rssFilename)
            });

            // Add mappings for favicon.ico and robots.txt.
            pageMappings.push({
                url: staticSiteConfig.baseUrl + 'favicon.ico',
                file: path.join(staticSiteConfig.targetDirectory, 'favicon.ico')
            });

            pageMappings.push({
                url: staticSiteConfig.baseUrl + 'robots.txt',
                file: path.join(staticSiteConfig.targetDirectory, 'robots.txt')
            });


            // Request then write each page.
            var pagePromises = _.map(pageMappings, function (pathMapping) {
                return requestAndWritePage(pathMapping.url, pathMapping.file);
            });

            // Copy static content.  Configure what we need to copy here.
            var staticContentPaths = [{
                source: path.join(configData.paths.corePath, 'built', 'public'),
                dest: path.join(staticSiteConfig.targetDirectory, 'public')
            }, {
                source: configData.paths.imagesPath,
                dest: path.join(staticSiteConfig.targetDirectory, configData.paths.imagesRelPath)
            }, {
                source: path.join(configData.paths.themePath, activeTheme, 'assets'),
                dest: path.join(staticSiteConfig.targetDirectory, 'assets')
            }];

            // Perform the copies.
            var staticContentCopyPromises = _.map(staticContentPaths, function (pair) {
                return nodefn.call(fs.copy, pair.source, pair.dest);
            });


            // Concatenate all of our promises.
            var allPromises = pagePromises
                .concat(staticContentCopyPromises);

            // Wait for all of the requests to complete.
            return when.all(allPromises).then(function () {
                return {
                    posts: postSlugs,
                    tags: tagSlugs
                }
            });
        });
    }
};

module.exports = staticsite;