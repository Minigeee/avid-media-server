import { createClient as createRedisClient } from 'redis';
import {
	MongoClient,
	ServerApiVersion,
	Collection,
	WithTransactionCallback,
	TransactionOptions
} from 'mongodb';

import { LogEntry } from 'avid-types';

import config from './config';

if (!config.db.mongo.url)
	throw new Error('mongodb url is missing');


// Create redis client
export const redis = createRedisClient({
	url: config.db.redis.url,
});
redis.connect().then(() => console.log('Connected to redis'));


// Collections
let _Logs: Collection<LogEntry>;

// Create mongodb client
export const mongodb = new MongoClient(
	config.db.mongo.url,
	{ serverApi: ServerApiVersion.v1 }
);

mongodb.connect().then(() => {
	console.log('Connected to mongodb');

	// Get collections
	const db = mongodb.db('main');

	_Logs = db.collection('Logs');
});

// Collection accessors
export function Logs() { return _Logs; }