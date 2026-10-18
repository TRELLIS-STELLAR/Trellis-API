import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository } from "typeorm";
import { EmailService } from "./email.service";
import { EmailQueueService } from "./services/email-queue.service";
import { TemplateEngineService } from "./services/template-engine.service";
import {
  EmailLog,
  EmailStatus,
  EmailProvider,
} from "./entities/email-log.entity";
import { SendEmailDto } from "./dto/send-email.dto";

const mockEmailLogRepository = () => ({
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
});
const mockEmailQueueService = () => ({
  enqueueEmail: jest.fn(),
  processEmail: jest.fn(),
  getPendingEmailCount: jest.fn(),
  getFailedEmailLogs: jest.fn(),
});
const mockConfigService = () => ({
  get: jest.fn(
    (key: string, fb?: any) =>
      ({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: "test@trellis.example" })[key] ||
      fb,
  ),
});

describe("EmailService", () => {
  let service: EmailService;
  let emailLogRepo: jest.Mocked<Repository<EmailLog>>;
  let queueService: EmailQueueService & {
    enqueueEmail: jest.Mock;
    processEmail: jest.Mock;
    getPendingEmailCount: jest.Mock;
    getFailedEmailLogs: jest.Mock;
  };
  let templateEngine: TemplateEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        TemplateEngineService,
        {
          provide: getRepositoryToken(EmailLog),
          useFactory: mockEmailLogRepository,
        },
        { provide: EmailQueueService, useFactory: mockEmailQueueService },
        { provide: ConfigService, useFactory: mockConfigService },
      ],
    }).compile();
    service = module.get<EmailService>(EmailService);
    emailLogRepo = module.get(getRepositoryToken(EmailLog));
    queueService = module.get(EmailQueueService) as any;
    templateEngine = module.get<TemplateEngineService>(TemplateEngineService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("sendEmail", () => {
    it("should queue a single email", async () => {
      const dto: SendEmailDto = {
        to: ["user@example.com"],
        subject: "Test",
        html: "<p>Hello</p>",
        text: "Hello",
      };
      const saved = { id: "uuid-1", status: EmailStatus.QUEUED };
      emailLogRepo.create.mockReturnValue(saved as any);
      emailLogRepo.save.mockResolvedValue(saved as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);
      const result = await service.sendEmail(dto);
      expect(emailLogRepo.create).toHaveBeenCalledTimes(1);
      expect(queueService.enqueueEmail).toHaveBeenCalledWith("uuid-1");
      expect(result.id).toBe("uuid-1");
    });

    it("should send to multiple recipients", async () => {
      const dto: SendEmailDto = {
        to: ["a@x.com", "b@x.com"],
        subject: "Multi",
        html: "<p>Bulk</p>",
      };
      emailLogRepo.create.mockReturnValue({ id: "x" } as any);
      emailLogRepo.save.mockResolvedValue({ id: "x" } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);
      await service.sendEmail(dto);
      expect(emailLogRepo.create).toHaveBeenCalledTimes(2);
    });

    it("should render template when templateName provided", async () => {
      const dto: SendEmailDto = {
        to: ["user@example.com"],
        subject: "Welcome",
        templateName: "welcome",
        templateVars: { name: "Alice" },
      };
      emailLogRepo.create.mockReturnValue({ id: "t1" } as any);
      emailLogRepo.save.mockResolvedValue({ id: "t1" } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);
      await service.sendEmail(dto);
      const c = emailLogRepo.create.mock.calls[0][0];
      expect(c.metadata.html).toContain("Alice");
      expect(c.metadata.html).not.toContain("{{name}}");
    });
  });

  describe("sendBulk", () => {
    it("should queue multiple emails", async () => {
      emailLogRepo.create.mockReturnValue({ id: "b1" } as any);
      emailLogRepo.save.mockResolvedValue({ id: "b1" } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);
      const r = await service.sendBulk({
        emails: [
          { to: ["a@x.com"], subject: "A", html: "<p>A</p>" },
          { to: ["b@x.com"], subject: "B", html: "<p>B</p>" },
        ],
      } as any);
      expect(r).toHaveLength(2);
    });
  });

  describe("getDeliveryStatus", () => {
    it("should return email log by id", async () => {
      emailLogRepo.findOne.mockResolvedValue({
        id: "u1",
        status: EmailStatus.SENT,
      } as any);
      expect((await service.getDeliveryStatus("u1")).id).toBe("u1");
    });
    it("should throw when not found", async () => {
      emailLogRepo.findOne.mockResolvedValue(null);
      await expect(service.getDeliveryStatus("missing")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("retryFailed", () => {
    it("should requeue a failed email", async () => {
      emailLogRepo.findOne.mockResolvedValue({
        id: "f1",
        status: EmailStatus.FAILED,
      } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);
      await service.retryFailed("f1");
      expect(emailLogRepo.update).toHaveBeenCalledWith("f1", {
        status: EmailStatus.QUEUED,
        attempts: 0,
        errorMessage: null,
      });
    });
    it("should throw if not failed", async () => {
      emailLogRepo.findOne.mockResolvedValue({
        id: "s1",
        status: EmailStatus.SENT,
      } as any);
      await expect(service.retryFailed("s1")).rejects.toThrow(
        "not in failed status",
      );
    });
  });

  describe("unsubscribe", () => {
    it("should mark recipient as unsubscribed", async () => {
      emailLogRepo.update.mockResolvedValue({ affected: 3 } as any);
      expect((await service.unsubscribe("user@example.com")).unsubscribed).toBe(
        true,
      );
    });
  });

  describe("template rendering", () => {
    it("should render template with variables", () => {
      expect(templateEngine.renderHtml("welcome", { name: "Bob" })).toContain(
        "Bob",
      );
    });
    it("should HTML-escape variable values", () => {
      expect(
        templateEngine.renderHtml("welcome", { name: "<script>" }),
      ).not.toContain("<script>");
    });
    it("should list all default templates", () => {
      expect(templateEngine.getAllTemplates().length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("createTemplate", () => {
    it("should create and store a template", async () => {
      const r = await service.createTemplate({
        name: "custom",
        htmlContent: "<p>Hey {{name}}</p>",
        subject: "Hi {{name}}",
      } as any);
      expect(r.name).toBe("custom");
      expect(templateEngine.renderHtml("custom", { name: "Carol" })).toContain(
        "Carol",
      );
    });
  });

  describe("i18n template rendering & interpolation", () => {
    it("should render Spanish (es) templates with interpolated variables", () => {
      const welcomeHtml = templateEngine.renderHtml(
        "welcome",
        { name: "Carlos" },
        "es",
      );
      expect(welcomeHtml).toContain("¡Bienvenido, Carlos!");
      expect(welcomeHtml).toContain("Tu cuenta ya está activa.");
      expect(templateEngine.renderSubject("welcome", {}, "es")).toBe(
        "¡Bienvenido a Trellis!",
      );

      const resetHtml = templateEngine.renderHtml(
        "password-reset",
        {
          name: "Elena",
          resetUrl: "https://trellis.app/reset",
          expiresIn: "10m",
        },
        "es",
      );
      expect(resetHtml).toContain("Restablecer contraseña");
      expect(resetHtml).toContain("trellis.app");
      expect(resetHtml).toContain("10m");
      expect(templateEngine.renderSubject("password-reset", {}, "es")).toBe(
        "Solicitud de restablecimiento de contraseña",
      );
    });

    it("should render French (fr) templates with interpolated variables", () => {
      const welcomeHtml = templateEngine.renderHtml(
        "welcome",
        { name: "Amélie" },
        "fr",
      );
      expect(welcomeHtml).toContain("Bienvenue, Amélie !");
      expect(welcomeHtml).toContain("Votre compte est désormais actif.");
      expect(templateEngine.renderSubject("welcome", {}, "fr")).toBe(
        "Bienvenue sur Trellis !",
      );

      const verifyHtml = templateEngine.renderHtml(
        "email-verification",
        {
          name: "Amélie",
          verificationUrl: "https://trellis.app/verify",
          expiresIn: "15m",
        },
        "fr",
      );
      expect(verifyHtml).toContain("Vérifiez votre adresse e-mail");
      expect(verifyHtml).toContain("trellis.app");
      expect(templateEngine.renderSubject("email-verification", {}, "fr")).toBe(
        "Vérifiez votre adresse e-mail",
      );
    });

    it("should render German (de) templates with interpolated variables", () => {
      const welcomeHtml = templateEngine.renderHtml(
        "welcome",
        { name: "Hans" },
        "de",
      );
      expect(welcomeHtml).toContain("Willkommen, Hans!");
      expect(welcomeHtml).toContain("Ihr Konto ist jetzt aktiv.");
      expect(templateEngine.renderSubject("welcome", {}, "de")).toBe(
        "Willkommen bei Trellis!",
      );

      const resetSubject = templateEngine.renderSubject(
        "password-reset",
        {},
        "de",
      );
      expect(resetSubject).toBe("Passwort-Zurücksetzungsanfrage");
      const notificationHtml = templateEngine.renderHtml(
        "notification",
        {
          name: "Hans",
          title: "Aktualisierung",
          message: "Neuigkeiten",
          unsubscribeUrl: "https://trellis.app/optout",
        },
        "de",
      );
      expect(notificationHtml).toContain("Aktualisierung");
      expect(notificationHtml).toContain("Neuigkeiten");
      expect(notificationHtml).toContain("Abmelden");
    });

    it("should fall back gracefully to English when requested locale template is missing", () => {
      // Locale 'it' or 'ja' is not provided in dictionary, should fall back to English without errors
      const fallbackHtml = templateEngine.renderHtml(
        "welcome",
        { name: "Marco" },
        "it",
      );
      expect(fallbackHtml).toContain("Welcome, Marco!");
      expect(fallbackHtml).toContain("Your account is now active.");
      expect(templateEngine.renderSubject("welcome", {}, "it")).toBe(
        "Welcome to Trellis!",
      );

      const unknownLocaleHtml = templateEngine.renderHtml(
        "password-reset",
        { name: "Kenji", resetUrl: "https://trellis.app/r", expiresIn: "5m" },
        "ja",
      );
      expect(unknownLocaleHtml).toContain("Password Reset");
      expect(templateEngine.renderSubject("password-reset", {}, "ja")).toBe(
        "Password Reset Request",
      );
    });
  });

  describe("parseUserLocale", () => {
    it("should parse locale from preferredLanguage", () => {
      expect(service.parseUserLocale({ preferredLanguage: "es" } as any)).toBe(
        "es",
      );
      expect(service.parseUserLocale({ preferredLanguage: "fr" } as any)).toBe(
        "fr",
      );
      expect(service.parseUserLocale({ preferredLanguage: "de" } as any)).toBe(
        "de",
      );
    });

    it("should parse locale from locale property", () => {
      expect(service.parseUserLocale({ locale: "es" } as any)).toBe("es");
      expect(service.parseUserLocale({ locale: "fr" } as any)).toBe("fr");
    });

    it("should extract base language from complex locale tags", () => {
      expect(
        service.parseUserLocale({ preferredLanguage: "es-MX" } as any),
      ).toBe("es");
      expect(service.parseUserLocale({ locale: "fr-FR" } as any)).toBe("fr");
      expect(
        service.parseUserLocale({ preferredLanguage: "de_DE" } as any),
      ).toBe("de");
      expect(service.parseUserLocale({ locale: "EN-US" } as any)).toBe("en");
    });

    it("should fall back to English (en) when user or locale is missing or empty", () => {
      expect(service.parseUserLocale(null)).toBe("en");
      expect(service.parseUserLocale(undefined)).toBe("en");
      expect(service.parseUserLocale({} as any)).toBe("en");
      expect(service.parseUserLocale({ preferredLanguage: "" } as any)).toBe(
        "en",
      );
      expect(service.parseUserLocale({ locale: null } as any)).toBe("en");
    });
  });

  describe("sendEmail with user locale", () => {
    it("should render email in user's preferred language when locale is supplied", async () => {
      const dto: SendEmailDto = {
        to: ["carlos@example.com"],
        subject: "Welcome",
        templateName: "welcome",
        templateVars: { name: "Carlos" },
        locale: "es",
      };
      emailLogRepo.create.mockReturnValue({ id: "es-1" } as any);
      emailLogRepo.save.mockResolvedValue({ id: "es-1" } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);

      await service.sendEmail(dto);
      const call = emailLogRepo.create.mock.calls[0][0];
      expect(call.metadata.html).toContain("¡Bienvenido, Carlos!");
      expect(call.metadata.locale).toBe("es");
      expect(call.subject).toBe("¡Bienvenido a Trellis!");
    });

    it("should parse locale from user object on dto", async () => {
      const dto: SendEmailDto = {
        to: ["amelie@example.com"],
        subject: "Welcome",
        templateName: "welcome",
        templateVars: { name: "Amélie" },
        user: { preferredLanguage: "fr" },
      };
      emailLogRepo.create.mockReturnValue({ id: "fr-1" } as any);
      emailLogRepo.save.mockResolvedValue({ id: "fr-1" } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);

      await service.sendEmail(dto);
      const call = emailLogRepo.create.mock.calls[0][0];
      expect(call.metadata.html).toContain("Bienvenue, Amélie !");
      expect(call.metadata.locale).toBe("fr");
      expect(call.subject).toBe("Bienvenue sur Trellis !");
    });

    it("should gracefully fall back to English when unknown locale is requested", async () => {
      const dto: SendEmailDto = {
        to: ["user@example.com"],
        subject: "Welcome",
        templateName: "welcome",
        templateVars: { name: "Hiro" },
        locale: "ja",
      };
      emailLogRepo.create.mockReturnValue({ id: "ja-1" } as any);
      emailLogRepo.save.mockResolvedValue({ id: "ja-1" } as any);
      queueService.enqueueEmail.mockResolvedValue({ id: 1 } as any);

      await service.sendEmail(dto);
      const call = emailLogRepo.create.mock.calls[0][0];
      expect(call.metadata.html).toContain("Welcome, Hiro!");
      expect(call.subject).toBe("Welcome to Trellis!");
    });
  });
});
