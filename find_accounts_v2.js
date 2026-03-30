const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 6379, password: 'Root,./000000', db: 8 });

(async () => {
  // 从共享池获取
  const sharedAccounts = await redis.smembers('shared_claude_accounts');
  
  console.log(`共享池中有 ${sharedAccounts.length} 个 Claude 账户\n`);
  
  for (const accountId of sharedAccounts.slice(0, 5)) {
    const key = `claude:${accountId}`;
    const type = await redis.type(key);
    
    if (type === 'hash') {
      const data = await redis.hgetall(key);
      console.log(`ID: ${accountId}`);
      console.log(`  Name: ${data.name || 'unnamed'}`);
      console.log(`  Status: ${data.status}`);
      console.log(`  IsActive: ${data.isActive}`);
      console.log(`  Schedulable: ${data.schedulable}`);
      console.log('');
    }
  }
  
  await redis.quit();
})();
