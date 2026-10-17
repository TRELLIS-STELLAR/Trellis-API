import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  EmailLog,
  EmailProvider,
  EmailStatus,
} from "./entities/email-log.entity";
import {
  SendEmailDto,
  SendBulkEmailDto,
  CreateTemplateDto,
} from "./dto/send-email.dto";
import { EmailQueueService } from "./services/email-queue.service";
import { TemplateEngineService } from "./services/template-engine.service";
import { User, parseUserLocale } from "../core/user/entities/user.entity";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @InjectRepository(EmailLog)
    private readonly emailLogRepository: Repository<EmailLog>,
    private readonly emailQueueService: EmailQueueService,
    private readonly templateEngineService: TemplateEngineService,
    private readonly configService: ConfigService,
    @Optional()
    @InjectRepository(User)
    private readonly userRepository?: Repository<User>,
  ) {}

  /**
   * Parses user preferred language locale from User entity.
   * Gracefully defaults to 'en' if not provided or unsupported.
   */
  parseUserLocale(user?: Partial<User> | null): string {
    return parseUserLocale(user);
  }

  async sendEmail(dto: SendEmailDto): Promise<EmailLog> {
    const provider = this.resolveProvider();

    // Determine user preferred locale: from dto.locale, dto.user, or optional user repository lookup
    let locale = "en";
    if (dto.locale) {
      locale = this.parseUserLocale({ locale: dto.locale });
    } else if (dto.user) {
      locale = this.parseUserLocale(dto.user);
    } else if (this.userRepository && dto.to.length === 1) {
      try {
        const foundUser = await this.userRepository.findOne({
          where: { email: dto.to[0] },
        });
        if (foundUser) {
          locale = this.parseUserLocale(foundUser);
        }
      } catch {
        // Fall back gracefully to English
      }
    }

    let html = dto.html || "",
      text = dto.text || "",
      subject = dto.subject;
    if (dto.templateName) {
      subject = this.templateEngineService.renderSubject(
        dto.templateName,
        dto.templateVars || {},
        locale,
      );
      html = this.templateEngineService.renderHtml(
        dto.templateName,
        dto.templateVars || {},
        locale,
      );
      text = this.templateEngineService.renderText(
        dto.templateName,
        dto.templateVars || {},
        locale,
      );
    }
    if (dto.html && !dto.text) {
      text = this.templateEngineService.generatePlainText(dto.html);
    }
    const senderEmail =
      this.configService.get<string>("EMAIL_FROM") || "noreply@trellis.example";
    const emailLogs: EmailLog[] = [];
    for (const recipient of dto.to) {
      const emailLog = this.emailLogRepository.create({
        recipientEmail: recipient,
        senderEmail,
        subject,
        templateName: dto.templateName,
        templateVars: dto.templateVars,
        provider,
        status: EmailStatus.QUEUED,
        maxAttempts: 5,
        metadata: {
          html,
          text,
          locale,
          attachments: dto.attachments,
          priority: dto.priority || "normal",
        },
      });
      const saved = await this.emailLogRepository.save(emailLog);
      emailLogs.push(saved);
      await this.emailQueueService.enqueueEmail(saved.id);
      this.logger.log(
        `Email queued: ${saved.id} to ${recipient} via ${provider}`,
      );
    }
    return emailLogs[0];
  }

  async sendBulk(dto: SendBulkEmailDto): Promise<EmailLog[]> {
    const results: EmailLog[] = [];
    for (const emailDto of dto.emails) {
      results.push(await this.sendEmail(emailDto));
    }
    this.logger.log(`Bulk email: ${results.length} queued`);
    return results;
  }

  async getDeliveryStatus(id: string): Promise<EmailLog> {
    const log = await this.emailLogRepository.findOne({ where: { id } });
    if (!log) {
      throw new NotFoundException(`Email log ${id} not found`);
    }
    return log;
  }

  async retryFailed(id: string): Promise<EmailLog> {
    const log = await this.emailLogRepository.findOne({ where: { id } });
    if (!log) {
      throw new NotFoundException(`Email log ${id} not found`);
    }
    if (log.status !== EmailStatus.FAILED) {
      throw new Error(
        `Email ${id} is not in failed status (current: ${log.status})`,
      );
    }
    await this.emailLogRepository.update(id, {
      status: EmailStatus.QUEUED,
      attempts: 0,
      errorMessage: null,
    });
    await this.emailQueueService.enqueueEmail(id);
    this.logger.log(`Email ${id} requeued for retry`);
    return this.emailLogRepository.findOne({ where: { id } });
  }

  async unsubscribe(email: string): Promise<{ unsubscribed: boolean }> {
    await this.emailLogRepository.update(
      { recipientEmail: email },
      { unsubscribed: true },
    );
    this.logger.log(`Unsubscribed ${email}`);
    return { unsubscribed: true };
  }

  async getTemplates() {
    return this.templateEngineService.getAllTemplates();
  }
  async createTemplate(dto: CreateTemplateDto) {
    return this.templateEngineService.createTemplate({
      name: dto.name,
      htmlContent: dto.htmlContent,
      textContent: dto.textContent,
      subject: dto.subject,
      description: dto.description,
    });
  }

  private resolveProvider(): EmailProvider {
    const configured = this.configService.get<string>(
      "EMAIL_PROVIDER",
      "smtp",
    ) as EmailProvider;
    const map: Record<string, EmailProvider> = {
      smtp: EmailProvider.SMTP,
      sendgrid: EmailProvider.SENDGRID,
      ses: EmailProvider.SES,
    };
    return map[configured] || EmailProvider.SMTP;
  }
}
