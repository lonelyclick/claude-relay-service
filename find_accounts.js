const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 6379, password: 'Root,./000000', db: 8 });

(async () => {
  // 获取一个可用的 claude-official 账户
  const accounts = await redis.keys('claude:*');
  
  console.log('找到 Claude 账户:\n');
  
  for (const key of accounts.slice(0, 10)) {
    const data = await redis.hgetall(key);
    if (data.id) {
      const isActive = data.isActive === 'true';
      const isNotError = data.status !== 'error';
      
      console.log(`ID: ${data.id}`);
      console.log(`  Name: ${data.name || 'unnamed'}`);
      console.log(`  Status: ${data.status}`);
      console.log(`  IsActive: ${isActive}`);
      console.log(`  Schedulable: ${data.schedulable}`);
      console.log('');
      
      if (isActive && isNotError) {
        console.log(`✅ 推荐使用这个账户: ${data.id}`);
        break;
      }
    }
  }
  
  await redis.quit();
})();
