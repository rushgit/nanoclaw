import {
  Client,
  WSClient,
  AppType,
  Domain,
  EventDispatcher,
} from '@larksuiteoapi/node-sdk';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Client | null = null;
  private wsClient: WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private verificationToken?: string;
  private encryptKey?: string;

  constructor(
    opts: FeishuChannelOpts,
    appId: string,
    appSecret: string,
    verificationToken?: string,
    encryptKey?: string,
  ) {
    this.opts = opts;
    this.appId = appId;
    this.appSecret = appSecret;
    this.verificationToken = verificationToken;
    this.encryptKey = encryptKey;
  }

  async connect(): Promise<void> {
    console.log('🔥 FeishuChannel connect method called');
    try {
      logger.info({ appId: this.appId }, 'Initializing Feishu client...');

      // Initialize Lark SDK client
      this.client = new Client({
        appId: this.appId,
        appSecret: this.appSecret,
        appType: AppType.SelfBuild,
        domain: Domain.Feishu,
      });

      logger.info(
        { appId: this.appId },
        'Initializing Feishu WebSocket client...',
      );

      // Initialize WebSocket client for receiving events
      const wsConfig: any = {
        appId: this.appId,
        appSecret: this.appSecret,
        domain: Domain.Feishu,
        autoReconnect: true,
      };

      // Add optional security parameters if provided
      if (this.verificationToken) {
        wsConfig.verificationToken = this.verificationToken;
      }
      if (this.encryptKey) {
        wsConfig.encryptKey = this.encryptKey;
      }

      this.wsClient = new WSClient(wsConfig);

      // Set up event dispatcher
      const eventDispatcher = new EventDispatcher({
        verificationToken: this.verificationToken,
        encryptKey: this.encryptKey,
      });
      eventDispatcher.register({
        // Handle message events
        'im.message.receive_v1': async (data: any) => {
          logger.debug({ appId: this.appId }, 'Received Feishu message event');
          await this.handleMessage(data);
        },
        // Handle connection events
        '*': async (data: any) => {
          logger.debug(
            { appId: this.appId, eventType: data?.type || 'unknown' },
            'Received Feishu WebSocket event',
          );
        },
      });

      logger.info(
        { appId: this.appId },
        'Starting Feishu WebSocket connection...',
      );

      // Start WebSocket connection
      await this.wsClient.start({
        eventDispatcher,
      });

      logger.info(
        { appId: this.appId },
        'Feishu WebSocket connected successfully',
      );
    } catch (err) {
      const error = err as Error;
      logger.error(
        { appId: this.appId, err: error.message },
        'Failed to connect Feishu WebSocket',
      );
      throw err;
    }
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      // 1. 核心修复：飞书 SDK 已经解包，data 本身就是 event 对象！
      const event = data.event || data;

      if (!event || !event.message) {
        logger.warn({ data }, 'Received malformed Feishu message event');
        return;
      }

      const message = event.message;
      const chatId = message.chat_id;
      const messageId = message.message_id;

      // 2. 预防性修复：飞书的 sender_id 是一个对象，我们需要提取里面的 open_id 或 user_id
      const senderIdObj = event.sender?.sender_id || {};
      const senderId =
        senderIdObj.open_id ||
        senderIdObj.user_id ||
        senderIdObj.union_id ||
        'unknown_sender';

      const chatType = message.chat_type;
      const content = JSON.parse(message.content);
      const text = content.text || '';

      // Handle /chatid command
      if (text.trim() === '/chatid') {
        await this.sendChatId(chatId, chatType);
        return;
      }

      // Skip other system messages or commands
      if (text.startsWith('/')) return;

      const chatJid = `fs:${chatId}`;
      const timestamp = new Date(
        parseInt(event.create_time || Date.now().toString()),
      ).toISOString();

      // Get sender name and chat name
      const senderName = await this.getSenderName(senderId);
      const chatName = await this.getChatName(chatId, chatType);

      // Determine if it's a group chat
      const isGroup = chatType === 'group';

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

      // ⚠️ 注意：NanoClaw 默认只处理“已注册群组”或“主群组”的消息
      // 如果你是在单聊测试，我们需要确保单聊消息也能透传给 Agent
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        // 临时 Debug 日志：如果你发现消息没回，可能是因为这个聊天没有被注册
        logger.info(
          { chatJid, chatName, text },
          'Message received from unregistered Feishu chat. (If you want the bot to reply in DMs, you may need to register this chat ID)',
        );
        // 暂时注释掉 return，强制让单聊消息也进入处理队列（仅供测试）
        // return;
      }

      let processedText = text;

      // Deliver message to NanoClaw core
      this.opts.onMessage(chatJid, {
        id: messageId,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: processedText,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, text: processedText },
        '✅ Feishu message successfully parsed and stored!',
      );
    } catch (err) {
      logger.error({ err, data }, 'Failed to handle Feishu message');
    }
  }

  private async getSenderName(senderId: string): Promise<string> {
    try {
      if (!this.client) return 'Unknown';
      const response = await this.client.contact.user.get({
        path: { user_id: senderId },
        // 1. 核心修复：必须明确告诉飞书，我们传的是 open_id
        params: { user_id_type: 'open_id' },
      });
      return response.data?.user?.name || senderId;
    } catch (err) {
      // 降级处理：如果没权限获取名字，直接返回 ID，不要抛出异常
      return senderId;
    }
  }

  private async getChatName(chatId: string, chatType: string): Promise<string> {
    try {
      if (!this.client) return 'Unknown';
      if (chatType === 'p2p') {
        // 2. 核心修复：飞书的 chatId 是不透明的，绝对不能 split！直接返回默认名称。
        return 'Private Chat';
      } else {
        const response = await this.client.im.chat.get({
          path: { chat_id: chatId },
        });
        return response.data?.name || chatId;
      }
    } catch (err) {
      return chatId;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^fs:/, '');

      // Feishu API has message length limits
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        });
      } else {
        // Split long messages
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: text.slice(i, i + MAX_LENGTH) }),
            },
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  private async sendChatId(chatId: string, chatType: string): Promise<void> {
    try {
      if (!this.client) return;
      const chatName = await this.getChatName(chatId, chatType);
      const message = `Chat ID: \`fs:${chatId}\`\nName: ${chatName}\nType: ${chatType}`;
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: message }),
        },
      });
      logger.info({ chatId, chatName }, 'Sent /chatid response');
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send /chatid response');
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
      this.client = null;
      logger.info('Feishu WebSocket disconnected');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Feishu doesn't support typing indicators
    // Implement if API becomes available
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_ENCRYPT_KEY',
  ]);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';

  logger.info(
    {
      appId: appId ? 'set' : 'missing',
      appSecret: appSecret ? 'set' : 'missing',
    },
    'Feishu channel factory',
  );
  logger.debug(
    {
      appId: appId ? `${appId.substring(0, 4)}...` : 'empty',
      appSecret: appSecret ? '***' : 'empty',
    },
    'Feishu credentials debug',
  );

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }

  const verificationToken =
    process.env.FEISHU_VERIFICATION_TOKEN || envVars.FEISHU_VERIFICATION_TOKEN;
  const encryptKey =
    process.env.FEISHU_ENCRYPT_KEY || envVars.FEISHU_ENCRYPT_KEY;

  console.log(
    `🔥 FeishuChannel factory returning instance, appId=${appId ? 'set' : 'empty'}`,
  );
  return new FeishuChannel(
    opts,
    appId,
    appSecret,
    verificationToken,
    encryptKey,
  );
});
