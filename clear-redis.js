// clear-redis.js
const Redis = require('ioredis');

const redis = new Redis({
  host: "redis-13389.crce206.ap-south-1-1.ec2.cloud.redislabs.com",
  port: 13389,
  password: 'MLw14SQjjwFQ2lz8CMARCIBt94twnYHn',
});

async function clearClients() {
  try {
    // Get current client info
    const info = await redis.info('clients');
    const connectedClients = info.match(/connected_clients:(\d+)/)?.[1];
    console.log('Current connected clients:', connectedClients);
    
    // List all clients to see what's connected
    const clients = await redis.call('CLIENT', 'LIST');
    console.log('Connected clients:');
    console.log(clients);
    
    // Try different approaches to clear connections
    
    // Method 1: Kill by ID (extract client IDs first)
    const clientList = clients.split('\n');
    let killedCount = 0;
    
    for (const client of clientList) {
      if (client.includes('id=')) {
        const idMatch = client.match(/id=(\d+)/);
        if (idMatch) {
          const clientId = idMatch[1];
          try {
            // Skip killing the current connection
            const myId = await redis.call('CLIENT', 'ID');
            if (clientId !== myId.toString()) {
              await redis.call('CLIENT', 'KILL', 'ID', clientId);
              killedCount++;
              console.log(`Killed client ${clientId}`);
            }
          } catch (err) {
            console.log(`Could not kill client ${clientId}:`, err.message);
          }
        }
      }
    }
    
    console.log(`Total clients killed: ${killedCount}`);
    
    // Check final state
    const finalInfo = await redis.info('clients');
    const finalClients = finalInfo.match(/connected_clients:(\d+)/)?.[1];
    console.log('Final client count:', finalClients);
    
  } catch (err) {
    console.error('Error:', err.message);
    console.error('Full error:', err);
  } finally {
    await redis.quit();
  }
}

clearClients();