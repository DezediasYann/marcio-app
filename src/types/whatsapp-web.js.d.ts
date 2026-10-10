/**
 * Declarações de tipo mínimas para whatsapp-web.js.
 *
 * O whatsapp-web.js não traz @types próprios. Esta declaração cobre apenas
 * o que o Márcio App usa nas Fases 1-3. Conforme formos usando mais
 * (Poll, MessageMedia, etc.), expandimos aqui.
 *
 * Mantemos `any` em muitos lugares de propósito — a lib é dinâmica e tentar
 * tipar tudo agora ia atrasar a refatoração. Endurecemos aos poucos.
 */

declare module 'whatsapp-web.js' {
  export class Client {
    constructor(options?: ClientOptions);
    initialize(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'qr', listener: (qr: string) => void): this;
    on(event: 'authenticated', listener: (session: any) => void): this;
    on(event: 'auth_failure', listener: (msg: string) => void): this;
    on(event: 'ready', listener: () => void): this;
    on(event: 'message_create', listener: (msg: Message) => void): this;
    on(event: 'message', listener: (msg: Message) => void): this;
    on(event: 'loading_screen', listener: (percent: string, message: string) => void): this;
    on(event: 'disconnected', listener: (reason: string) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    sendMessage(chatId: string, content: string | MessageMedia | any, options?: any): Promise<Message>;
    getChats(): Promise<Chat[]>;
    getChatById(chatId: string): Promise<Chat>;
    getContactById(contactId: string): Promise<Contact>;
    getMessageById(messageId: string): Promise<Message>;
    info: { wid: { _serialized: string; user: string }; pushname: string };
  }

  export class LocalAuth {
    constructor(options?: { dataPath?: string; clientId?: string });
  }

  export class MessageMedia {
    constructor(mimetype: string, data: string, filename?: string);
    static fromFilePath(filePath: string): MessageMedia;
    mimetype: string;
    data: string;
    filename?: string;
  }

  export class Poll {
    constructor(pollName: string, pollOptions: string[], options?: { allowMultipleAnswers?: boolean; messageSecret?: number[] });
  }

  export interface ClientOptions {
    authStrategy?: any;
    puppeteer?: {
      headless?: boolean | 'new';
      args?: string[];
      executablePath?: string;
      userDataDir?: string;
    };
    session?: any;
  }

  export interface Message {
    id: { _serialized: string; fromMe: boolean; remote: any };
    from: string;
    to: string;
    fromMe: boolean;
    body: string;
    timestamp: number;
    hasMedia: boolean;
    hasQuotedMsg: boolean;
    type: string;
    mentionedIds?: string[];
    author?: string;
    deviceType?: string;
    isStatus?: boolean;
    raw: any;

    reply(content: string, chatId?: string, options?: any): Promise<Message>;
    react(emoji: string): Promise<void>;
    getChat(): Promise<Chat>;
    getContact(): Promise<Contact>;
    getQuotedMessage(): Promise<Message>;
    downloadMedia(): Promise<MessageMedia | null>;
    forward(chatId: string): Promise<void>;
    delete(everyone?: boolean): Promise<void>;
  }

  export interface Chat {
    id: { _serialized: string; user: string; server: string };
    name?: string;
    formattedTitle?: string;
    isGroup: boolean;
    isReadOnly: boolean;
    timestamp?: number;
    lastMessage?: Message;
    participants?: { id: { _serialized: string }; isAdmin?: boolean; isSuperAdmin?: boolean }[];
    unreadCount?: number;
    sendStateTyping(): Promise<void>;
    clearStateTyping(): Promise<void>;
    fetchMessages(options: { limit: number }): Promise<Message[]>;
    sendMessage(content: string | MessageMedia | any, options?: any): Promise<Message>;
    markUnread(): Promise<void>;
  }

  export interface Contact {
    id: { _serialized: string; user: string; server: string };
    number?: string;
    name?: string;
    pushname?: string;
    shortName?: string;
    isBusiness?: boolean;
    isMe?: boolean;
    isGroup?: boolean;
    getProfilePicUrl(): Promise<string>;
  }
}

declare module 'qrcode-terminal' {
  export function generate(input: string, options?: { small?: boolean }, cb?: (qr: string) => void): void;
}
