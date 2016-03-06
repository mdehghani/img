var path = require('path');
var http = require('http');
var fs = require('fs');
var mkdirp = require('mkdirp');
var express = require('express');
var async = require('async');
var sharp = require('sharp');
var app = express();
var argv = require('minimist')(process.argv.slice(2));
var gm = require('gm').subClass({imageMagick: true});
const cluster = require('cluster');
const memCache = require('./mem-cache');
const numCPUs = require('os').cpus().length;

var basePath = argv.base || 'files';
var cacheBasePath = argv.cache || 'cache';
var redis = true;
var STEP = 50;

var mainUrl = 'img.taaghche.ir';

// var transformer = sharp('a.jpg')
	// .resize(10, 10)
	// .on('error', function(err) {
	// 	console.log(err);
	// })
	// .toFile('b.jpg', function(err) {
	// 	console.log('x', err);
	// });


function exists(filePath, cb) {
	// console.log('exists', filePath);
	fs.stat(filePath, function(err, stat) {
		if (!err && stat) return cb(true);
		cb(false);
	});
}

function write(src, dst, cb) {
	// console.log('write', src, dst);
	mkdirp(path.dirname(dst), function() {
		var rs = fs.createReadStream(src);
		var ws = fs.createWriteStream(dst);
		rs.pipe(ws);
		rs.on('end', function() {
			if (cb) cb();
		});
		rs.on('error', function(err) {
			if (cb) cb(err);
		});
	})
}

var resizeQ = async.queue(function(item, cb) {
	var transformer = sharp(item.path)
	.resize(item.size.w || undefined, item.size.h || undefined)
	.on('error', function(err) {
		item.cb(err);
		cb();
	})
	.toFile(item.cachePath, function(err) {
		item.cb(err);
		cb();
	});


	// var g = gm(item.path);
	// var gmResult = g.resize(item.size.w || undefined, item.size.h || undefined);
	// gmResult.write(item.cachePath, item.cb);
}, 20);

var requestQ = async.queue(function(item, callback) {
	var options = {
		hostname: mainUrl,
	    path: item.req.url
	}
	var request = http.request(options, function(rs) {
		if (rs.statusCode != 200) {
			item.cb(rs.statusCode);
			callback();
			return;
		}
		mkdirp(path.dirname(item.cachePath), function() {
			var ws = fs.createWriteStream(item.cachePath);
			rs.pipe(ws);
			ws.on('finish', function() {
				item.setMemCacheAndSend(item.cachePath);
				callback();
			});
			ws.on('error', function() {
				item.cb('err');
				callback();
			})
		})
	});
	request.end();
}, 100);

function resize(filePath, size, cachePath, cb) {
	resizeQ.push({path: filePath, cachePath: cachePath, size: size, cb: cb});
}

function generatePath(folder, file) {
	var prefix = file.charAt(0);
	return path.join(folder, prefix, file)
}

function generateKey(folder, file) {
	return path.join(folder, file);
}

function getFile(p, key, req, size, cb) {
	var cachePath = path.join(cacheBasePath, p);
	var start = +new Date();
	memCache.get(p, function(err, data) {
		if (!err && data) //cache hit
			return cb(null, null, data);
		// cache miss or error
		var setMemCacheAndSend = function(resultPath) {
			cb(null, resultPath);
			fs.readFile(resultPath, function(err, data) {
				// console.log(data.length);
				if (!err)
					memCache.set(p, data);
			})
		}
		//search in disk cache
		exists(cachePath, function(ex1) {
			if (ex1) return setMemCacheAndSend(cachePath);
			requestQ.push({req: req, cachePath: cachePath, setMemCacheAndSend: setMemCacheAndSend, cb: cb});
		});
	});
}

if (cluster.isMaster) {
  // Fork workers.
  for (var i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {

	app.get('/:folder/:file', function (req, res) {
		var folder = req.params.folder;
		var file = req.params.file;

		folder = folder.toLowerCase();
		file = file.toLowerCase();

		// console.log(folder, file);
		var origPath = generatePath(folder, file);
		var key = generateKey(folder, file);
		var w = req.query.w || req.query.width;
		var h = req.query.h || req.query.height;
		var resizedPath = origPath;
		var size = null;
		w = +w;
		h = +h;
		if (w || h) {
			var parsed = path.parse(origPath);
			if (w) h = null;
			w = w || 0;
			h = h || 0;
			if (w % STEP)
				w = Math.ceil(w / STEP) * STEP;
			if (h % STEP)
				h = Math.ceil(h / STEP) * STEP;
			resizedPath = path.join(parsed.dir, parsed.name + '_' + (w || 0) + '_' + (h || 0) + parsed.ext);
			size = {w: +w, h: +h};
		}

		getFile(resizedPath, key, req, size, function(err, filePath, data) {
			// if (filePath)
			// 	console.log(filePath);
			var sendFilePath = function(fp) {
				if (fp) {
					res.sendFile(path.resolve(fp), function(err) {
						if (!err) return;
						// if (err.statusCode == 404)
						console.log(err);
						return res.sendStatus(500);
						// res.end();
					});
				}
				else {
					res.end(data);
				}
			}
			if (err == 'notFound') {
				res.sendStatus(404);
			}
			else if (err) return res.sendStatus(500);
			else if (!filePath && !data) {
				res.sendStatus(500);
			}
			else
				sendFilePath(filePath);
		
		});
		// var filePath = path.resolve(path.join(basePath, folder, file));
		// console.log(filePath);
		// gm(filePath)
		// .resizeExact(100, 100)
		// .stream(function (err, stdout, stderr) {
		//   stdout.pipe(res);
		// })
		// .write('/tmp/bahmaan.jpg', function() {

		// })

	});

	var port = argv.p || 37337;
	app.listen(port, function () {
	  console.log('image handler listening on port ' + port);
	});

}