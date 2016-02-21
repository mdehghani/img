var path = require('path');
var fs = require('fs');
var mkdirp = require('mkdirp');
var express = require('express');
var app = express();
var argv = require('minimist')(process.argv.slice(2));
var gm = require('gm').subClass({imageMagick: true});
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

var basePath = argv.base || 'files';
var cacheL1Path = argv.cache1 || '/mnt/ramdisk';
var cacheL2Path = argv.cache2 || 'cache';

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

function resize(filePath, size) {
	// console.log('resize', filePath);
	var g = gm(filePath);
	if (size.w && size.h)
		return g.resizeExact(size.w, size.h);
	return g.resize(size.w || undefined, size.h || undefined);
}

function getFile(p, originalPath, size, cb) {
	var l1 = true, l2 = true;
	var l1Path = path.join(cacheL1Path, p);
	var l2Path = path.join(cacheL2Path, p);
	var physicalPath = path.join(basePath, originalPath);

	exists(l1Path, function(ex1) {
		if (ex1) return cb(null, l1Path);
		var secondPath = size ? l2Path : physicalPath;
		exists(secondPath, function(ex2) {
			if (ex2) {
				write(secondPath, l1Path, function(err) {
					if (err) return cb(null, secondPath);
					return cb(null, l1Path);
				});
			}
			else if (!size)
				return cb('notFound');
			else {
				exists(physicalPath, function(ex) {
					if (!ex)
						return cb('notFound');
					var gmResult = resize(physicalPath, size);
					mkdirp(path.dirname(l2Path), function() {
						gmResult.write(l2Path, function(err) {
							if (err) return cb('full');
							cb(null, l2Path);
							write(l2Path, l1Path);
						})
					})
				})
			}
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
  });
} else {

	app.get('/:folder/:file', function (req, res) {
		var folder = req.params.folder;
		var file = req.params.file;

		// console.log(folder, file);
		var filePath = path.join(folder, file);
		var w = req.query.w;
		var h = req.query.h;
		var resizedPath = filePath;
		var size = null;
		if (w || h) {
			if (w > 4000 || h > 4000) return res.sendStatus(404);
			var parsed = path.parse(filePath);
			resizedPath = path.join(parsed.dir, parsed.name + '_' + (w || 0) + '_' + (h || 0) + parsed.ext);
			size = {w: +w, h: +h};
		}
		getFile(resizedPath, filePath, size, function(err, filePath) {
			console.log(filePath);
			if (err == 'notFound') return res.sendFile('/home/dehghani/code/img/files/frontcover/100.jpg'); //res.sendStatus(404);
			if (err) return res.sendStatus(500);
			res.sendFile(path.resolve(filePath), function(err) {
				if (!err) return;
				if (err.statusCode == 404) return res.sendStatus(404);
				console.log(err);
				res.end();
			});
			
		})


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