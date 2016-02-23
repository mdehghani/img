// MemCache
var redis = require("redis"),
    client = redis.createClient({detect_buffers: true, return_buffers: true});

client.on('error', function(err, a, b) {
	client.end();
});

var memCache = {
	get: function(p, cb) {
		client.get(p, cb);
	},
	set: function(p, val, cb) {
		client.set(p, val, cb);
	}
}

module.exports = memCache;