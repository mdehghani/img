var path = require('path');
var http = require('http');
var fs = require('fs');
var mkdirp = require('mkdirp');
var express = require('express');
var async = require('async');
var crypto = require('crypto');
var sharp = require('sharp');
var app = express();
var argv = require('minimist')(process.argv.slice(2));
var gm = require('gm').subClass({imageMagick: true});
const cluster = require('cluster');
var amqp = require('amqplib/callback_api');
const memCache = require('./mem-cache');
const numCPUs = require('os').cpus().length;

var basePath = argv.base || 'files';
var configPath = argv._[0] || 'config.json';
var config;
try {
	config = require('./' + (configPath));
}
catch(err) {
	config = {};
}

var cacheBasePath = argv.cache || config.cache || 'cache';
var redis = true;
var STEP = 50;

var mainUrl = 'test.taaghche.ir';

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
			var data = 0;
			rs.pipe(ws);
			ws.on('finish', function() {
				console.log(data, item.cachePath);
				if (data)
					item.setMemCacheAndSend(item.cachePath, item.cb);
				else {
					console.log('removed');
					fs.unlink(item.cachePath, function(){});
				}
				callback();
			});
			rs.on('data', function(dat) {
				data += dat.length;
			})
			ws.on('error', function() {
				item.cb('err');
				callback();
			})
		})
	});
	request.end();
}, 2000);

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
		var setMemCacheAndSend = function(resultPath, cb) {
			cb(null, resultPath);
			fs.readFile(resultPath, function(err, data) {
				// console.log(data.length);
				if (!err)
					memCache.set(p, data);
			})
		}
		//search in disk cache
		exists(cachePath, function(ex1) {
			if (ex1) return setMemCacheAndSend(cachePath, cb);
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
		var parsed = path.parse(origPath);
		w = +w;
		h = +h;
		if (w || h) {
			if (w) h = null;
			w = w || 0;
			h = h || 0;
			if (w % STEP)
				w = Math.ceil(w / STEP) * STEP;
			if (h % STEP)
				h = Math.ceil(h / STEP) * STEP;
			// resizedPath = path.join(parsed.dir, parsed.name + '_' + (w || 0) + '_' + (h || 0) + parsed.ext);
			resizedPath = path.join(resizedPath, (w || 0) + '_' + (h || 0) + parsed.ext);
			size = {w: +w, h: +h};
		}
		else
			resizedPath = path.join(resizedPath, 'orig' + parsed.ext);

		getFile(resizedPath, key, req, size, function(err, filePath, data) {
			// if (filePath)
			// 	console.log(filePath);
			var sendFilePath = function(fp) {
				var doSend = function() {
					res.setHeader('Cache-Control', 'public');
					var expires = new Date();
					expires.setHours(expires.getHours() + 10);
					res.setHeader('Expires', expires);
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

				var expected = req.headers['if-none-match'];
				var hash = crypto.createHash('sha256');
				hash.on('readable', function() {
				  var data = hash.read();
				  if (!data) return;
				  var etag = null;
				  if (data)
				  	etag = data.toString('hex');

				  if (expected && expected  == etag) return res.sendStatus(304).end();
				  res.setHeader('ETag', etag);
				  doSend();
				});
				if (fp) fs.createReadStream(fp).pipe(hash);
				else {
					hash.write(data);
					hash.end();
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

	var port = argv.port || config.port || 80;
	app.listen(port, function () {
	  console.log('image handler listening on port ' + port);
	});

}

function clear(folder, file, callback) {
	console.log("Requested to remove " + folder + "/" + file);
	var p = generatePath(folder, file);
	memCache.del(p, function(err) {
		if (err) return callback(err);
		fs.readdir(path.join(cacheBasePath, p), function(err, files) {
			if (err) return callback(err);
			async.eachLimit(files, 200, function(f, cb) {
				fs.unlink(path.join(cacheBasePath, p, f), cb);
			}, function(err) {
				// if (!err) {
				// 	fs.rmdir(path.join(cacheBasePath, p), function(err) {
				// 		if (err)
				// 			return console.log("err: ", err);
				// 		console.log("Removed " + path.join(cacheBasePath, generatePath(folder, file)));
				// 		callback(err);
				// 	})
				// }
				callback(err);
			})
		})
	});
}

var rabbitHost = config['rabbit-host'] || 'store.taaghche.ir';
var rabbitUsername = config['rabbit-username'] || 'raptor';
var rabbitPassword = config['rabbit-password'] || 'raptor';
//RabbitMq
var ex = 'image-update';
amqp.connect({hostname: rabbitHost, username: rabbitUsername, password: rabbitPassword}, function(err, conn) {
	if (err) return console.log('rabbitmq error(1): ' + err);
	conn.createChannel(function(err, ch) {
		if (err) return console.log('rabbitmq error(2): ' + err);
	    ch.assertExchange(ex, 'fanout', {durable: true})
  		ch.assertQueue('', {exclusive: true}, function(err, q) {
  			if (err) return console.log('rabbitmq error(3): ' + err);
	      ch.bindQueue(q.queue, ex, '');

	      ch.consume(q.queue, function(message) {
	        msg = JSON.parse(message.content.toString());
	        clear(msg.folder, msg.file, function(err) {
	        	// if (!err) ch.ack(message);
	        });
	      }, {noAck: false});
	    });
	});
});