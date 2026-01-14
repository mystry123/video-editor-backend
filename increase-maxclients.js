// increase-maxclients.js
const Redis = require('ioredis');

const redis = new Redis({
  host: 'redis-13389.crce206.ap-south-1-1.ec2.cloud.redislabs.com',
  port: 13389, // Your port from the logs
  password: 'MLw14SQjjwFQ2lz8CMARCIBt94twnYHn',
});

async function increaseMaxClients() {
  try {
    // Check current limit
    const current = await redis.config('GET', 'maxclients');
    console.log('Current maxclients:', current);
    
    // Increase to 200
    await redis.config('SET', 'maxclients', '200');
    
    // Verify
    const updated = await redis.config('GET', 'maxclients');
    console.log('Updated maxclients:', updated);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await redis.quit();
  }
}

increaseMaxClients();