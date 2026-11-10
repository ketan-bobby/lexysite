declare module "nodemailer/lib/mail-composer/index.js" {
  type Attachment = {
    filename: string;
    content: Buffer;
    contentType?: string;
    cid?: string;
    contentDisposition?: string;
  };
  type Options = {
    from?: string;
    to?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    replyTo?: string;
    headers?: Array<{ key: string; value: string }>;
    attachments?: Attachment[];
  };
  export default class MailComposer {
    constructor(options: Options);
    compile(): {
      build(callback: (error: Error | null, message: Buffer) => void): void;
    };
  }
}
