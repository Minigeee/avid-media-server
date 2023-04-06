import { createClient as createRedisClient } from 'redis';

// Create redis client
export const redis = createRedisClient({
	url: process.env.REDIS_CONNECTION_URL,
});
redis.connect().then(() => console.log('Connected to redis'));