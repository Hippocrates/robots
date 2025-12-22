import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import url from 'url';
import crypto from 'crypto';

import { RobotsGameInstance } from './robots_instance.js';

let directory = fs.realpathSync('.');
const wss = new WebSocketServer({noServer: true});

let contentTypeRedirects = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.png': 'image/png',
};

let redirects = {
	'/': '/robots.html',
	'/favicon.ico': '/warp.png',
};

let visitors = new Map();
let cachedFiles = new Map();

function parseCookies(request) {
	const results = new Map();
	const cookieHeader = request.headers?.cookie;
	if (!cookieHeader) return results;

	cookieHeader.split(`;`).forEach(function(cookie) {
		let [ name, ...rest] = cookie.split(`=`);
		name = name?.trim();
		if (!name) return;
		const value = rest.join(`=`).trim();
		if (!value) return;
		results.set(name, decodeURIComponent(value));
	});

	return results;
}

function getContentType(filename) {
	let ext = path.extname(filename)
	return contentTypeRedirects[ext] ?? 'text/html';
}

function getClientKey(request) {
	let cookies = parseCookies(request);
	let clientKey = cookies.get('clientkey') ?? undefined;
	if (clientKey === undefined) {
		clientKey = crypto.randomUUID();
		console.log(`Client generating new cookie ${clientKey}`);
	}
	
	if (visitors.get(clientKey) === undefined) {
		visitors.set(clientKey, []);
		console.log(`New Client detected ${clientKey}`);
	}
	
	return clientKey;
}

function handleError(clientKey, req, res, err, filename) {
	err = err.toString();
	if (err.search(`Error: ENOENT: no such file or directory, open `) == 0) {
		cachedFiles.delete(filename);
		return serveFile(clientKey, req, res, filename, null);
	}
	res.writeHead(500, {'Content-Type': 'text/html'});
	res.write("500'd");
	return res.end();
}

function serveFile(clientKey, req, res, filename, filedata) {
	if (filedata != null) {
		cachedFiles.set(filename, filedata);
	}

	if (filedata == null || filedata === undefined) {
		console.log(`File ${filename} not found`);
		res.writeHead(404, {'Content-Type': 'text/html'});
		res.write("404'd");
		return res.end();
	}
	
	let contentType = getContentType(filename);
	let headers = {'Content-Type': contentType,};
	
	headers['Set-Cookie'] = `clientkey=${clientKey}`;
	console.log(`cookie = ${clientKey}`);

	res.writeHead(200, headers);
	res.write(filedata);
	return res.end();
}

let robotsGameInstance = new RobotsGameInstance();
robotsGameInstance.initializeGame({});

function accept(req, res) {
	let clientKey = getClientKey(req);
	
	var q = url.parse(req.url, true);
	let originalUrl = decodeURIComponent(q.pathname);
	let resolvedFile = redirects[originalUrl] ?? originalUrl;

	// all incoming requests must be websockets
	if (!req.headers.upgrade || req.headers.upgrade.toLowerCase() != 'websocket') {
		let cachedEntry = cachedFiles.get(resolvedFile);
		if (cachedEntry !== undefined) {
			console.log(`Serving from cache ${resolvedFile}`);
			return serveFile(clientKey, req, res, resolvedFile, cachedEntry);
		}
		
		fs.readFile(directory + resolvedFile, function(err, data) {
			if (err != undefined) {
				return handleError(clientKey, req, res, err, resolvedFile);
			}
			return serveFile(clientKey, req, res, resolvedFile, data);
		});
		return;
	}

	res.end();
	return;
}

let server = http.createServer(accept)

server.on('upgrade', (req, socket, head) => {
	wss.handleUpgrade(req, socket, head, (socket) => {
		let clientKey = getClientKey(req);
		wss.emit('connection', socket, req);
		robotsGameInstance.onSocketConnect(clientKey, socket);
	});
});

server.listen(8080);
