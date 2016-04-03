// MemCache
var path = require('path');
var async = require('async');
var redis = require("redis"),
    client = redis.createClient({detect_buffers: true, return_buffers: true});

client.on('error', function(err, a, b) {
	console.log(err, a, b);
	client.end();
});

var memCache = {
	get: function(p, cb) {
		client.get(p, cb);
	},
	set: function(p, val, cb) {
		client.set(p, val, cb);
	},
	del: function(p, callback) {
		client.keys(p + path.sep + '*', function(err, keys) {
			if (err) return callback(err);
			async.eachLimit(keys, 200, function(key, cb) {
				client.del(key, cb);
			}, function(err) {
				callback(err);
			})
		});
	}
}

module.exports = memCache;