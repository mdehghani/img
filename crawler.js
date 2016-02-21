var http = require('http');
var fs = require('fs');
var path = require('path');
var async = require('async');

var array = [];
for (var i = 100; i < 7000; ++i)
	array.push(i);
console.log(array);

async.eachLimit(array, 100, function(i, cb) {
	console.log(i);
	var options = {
		host: 'img.taaghche.ir',
		path: '/frontcover/' + i + '.jpg'
	}
	var req = http.request(options, function(res) {
		// console.log(res.statusCode);
		if (res.statusCode != 200) return cb();
		var ws = fs.createWriteStream(path.join('files', 'frontcover', i + '.jpg'));
		res.pipe(ws);
		res.on('end', cb);
	});
	req.end();
	req.on('error', function(err) {
		console.log('x', err);
	})
}, function(err) {
	console.log(err);
})