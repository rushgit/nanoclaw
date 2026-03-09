import * as lark from '@larksuiteoapi/node-sdk';
// 修复1：添加环境变量加载（关键！）
import 'dotenv/config';
// 从 .env 读取配置（带验证）
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;

// 修复2：添加环境变量验证（避免无效连接）
if (!appId) {
  console.error('❌ 错误：FEISHU_APP_ID 未设置！请在 .env 文件中配置');
  process.exit(1);
}
if (!appSecret) {
  console.error('❌ 错误：FEISHU_APP_SECRET 未设置！请在 .env 文件中配置');
  process.exit(1);
}

console.log('🚀 正在尝试与飞书建立 WebSocket 长连接...');

// 1. 核心修复：创建标准的事件分发器 (EventDispatcher)
const eventDispatcher = new lark.EventDispatcher({
  // 如果你在飞书后台配置了 Encrypt Key，需要填在这里。如果没有配置，留空即可。
}).register({
  // 注册消息接收事件
  'im.message.receive_v1': async (data) => {
    console.log('📩 收到飞书消息:', JSON.stringify(data));
    return {}; // 必须返回一个对象，告诉飞书 SDK 我们处理成功了
  },
});

// 2. 创建 WebSocket 客户端
const client = new lark.WSClient({
  appId: appId,
  appSecret: appSecret,
  loggerLevel: lark.LoggerLevel.debug,
});

// 3. 启动客户端，并将分发器注入进去
client
  .start({
    eventDispatcher: eventDispatcher,
  })
  .then(() => {
    console.log('\n==================================================');
    console.log('✅ 长连接建立成功！(WebSocket Connected)');
    console.log(
      '👉 现在请保持此终端运行，立刻去飞书后台点击【切换为长连接】！',
    );
    console.log('==================================================\n');
  })
  .catch((err) => {
    console.error('❌ 连接失败:', err);
  });
