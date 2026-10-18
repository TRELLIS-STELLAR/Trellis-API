import * as fs from "fs";
import * as path from "path";

export interface I18nEmailTemplate {
  name: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
  description?: string;
}

export type SupportedLocale = "en" | "es" | "fr" | "de";
export const DEFAULT_LOCALE: SupportedLocale = "en";
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = [
  "en",
  "es",
  "fr",
  "de",
];

export const I18N_TEMPLATES: Record<
  string,
  Record<string, I18nEmailTemplate>
> = {
  en: {
    welcome: {
      name: "welcome",
      subject: "Welcome to Trellis!",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Welcome, {{name}}!</h1><p>Thank you for joining <strong>Trellis</strong>.</p><p>Your account is now active.</p></div>',
      textContent:
        "Welcome, {{name}}!\n\nThank you for joining Trellis.\nYour account is now active.",
      description: "Sent to new users upon registration",
    },
    "password-reset": {
      name: "password-reset",
      subject: "Password Reset Request",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Password Reset</h1><p>Hi {{name}},</p><p>We received a request to reset your password.</p><p><a href="{{resetUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Reset Password</a></p><p>This link expires in <strong>{{expiresIn}}</strong>.</p></div>',
      textContent:
        "Hi {{name}},\n\nReset link: {{resetUrl}}\nThis link expires in {{expiresIn}}.",
      description: "Sent when a user requests a password reset",
    },
    notification: {
      name: "notification",
      subject: "{{title}}",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h2>{{title}}</h2><p>Hi {{name}},</p><p>{{message}}</p><p style="color:#888;font-size:12px">Unsubscribe: <a href="{{unsubscribeUrl}}">Click here</a></p></div>',
      textContent:
        "Hi {{name}},\n\n{{title}}\n\n{{message}}\n\nUnsubscribe: {{unsubscribeUrl}}",
      description: "General notification email",
    },
    "email-verification": {
      name: "email-verification",
      subject: "Verify Your Email Address",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Verify Your Email</h1><p>Hi {{name}},</p><p>Please verify your email address:</p><p><a href="{{verificationUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Verify Email</a></p><p>This link expires in <strong>{{expiresIn}}</strong>.</p></div>',
      textContent:
        "Hi {{name}},\n\nVerify your email: {{verificationUrl}}\nThis link expires in {{expiresIn}}.",
      description: "Sent to verify a user email address",
    },
  },
  es: {
    welcome: {
      name: "welcome",
      subject: "¡Bienvenido a Trellis!",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>¡Bienvenido, {{name}}!</h1><p>Gracias por unirte a <strong>Trellis</strong>.</p><p>Tu cuenta ya está activa.</p></div>',
      textContent:
        "¡Bienvenido, {{name}}!\n\nGracias por unirte a Trellis.\nTu cuenta ya está activa.",
      description: "Enviado a los nuevos usuarios al registrarse",
    },
    "password-reset": {
      name: "password-reset",
      subject: "Solicitud de restablecimiento de contraseña",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Restablecer contraseña</h1><p>Hola {{name}},</p><p>Recibimos una solicitud para restablecer tu contraseña.</p><p><a href="{{resetUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Restablecer contraseña</a></p><p>Este enlace caduca en <strong>{{expiresIn}}</strong>.</p></div>',
      textContent:
        "Hola {{name}},\n\nEnlace de restablecimiento: {{resetUrl}}\nEste enlace caduca en {{expiresIn}}.",
      description:
        "Enviado cuando un usuario solicita restablecer la contraseña",
    },
    notification: {
      name: "notification",
      subject: "{{title}}",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h2>{{title}}</h2><p>Hola {{name}},</p><p>{{message}}</p><p style="color:#888;font-size:12px">Darse de baja: <a href="{{unsubscribeUrl}}">Haga clic aquí</a></p></div>',
      textContent:
        "Hola {{name}},\n\n{{title}}\n\n{{message}}\n\nDarse de baja: {{unsubscribeUrl}}",
      description: "Correo electrónico de notificación general",
    },
    "email-verification": {
      name: "email-verification",
      subject: "Verifica tu dirección de correo electrónico",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Verifica tu correo electrónico</h1><p>Hola {{name}},</p><p>Por favor verifica tu dirección de correo electrónico:</p><p><a href="{{verificationUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Verificar correo electrónico</a></p><p>Este enlace caduca en <strong>{{expiresIn}}</strong>.</p></div>',
      textContent:
        "Hola {{name}},\n\nVerifica tu correo electrónico: {{verificationUrl}}\nEste enlace caduca en {{expiresIn}}.",
      description: "Enviado para verificar la dirección de correo del usuario",
    },
  },
  fr: {
    welcome: {
      name: "welcome",
      subject: "Bienvenue sur Trellis !",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Bienvenue, {{name}} !</h1><p>Merci d\'avoir rejoint <strong>Trellis</strong>.</p><p>Votre compte est désormais actif.</p></div>',
      textContent:
        "Bienvenue, {{name}} !\n\nMerci d'avoir rejoint Trellis.\nVotre compte est désormais actif.",
      description: "Envoyé aux nouveaux utilisateurs lors de l'inscription",
    },
    "password-reset": {
      name: "password-reset",
      subject: "Demande de réinitialisation de mot de passe",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Réinitialisation de mot de passe</h1><p>Bonjour {{name}},</p><p>Nous avons reçu une demande de réinitialisation de votre mot de passe.</p><p><a href="{{resetUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Réinitialiser le mot de passe</a></p><p>Ce lien expire dans <strong>{{expiresIn}}</strong>.</p></div>',
      textContent:
        "Bonjour {{name}},\n\nLien de réinitialisation : {{resetUrl}}\nCe lien expire dans {{expiresIn}}.",
      description:
        "Envoyé lorsqu'un utilisateur demande la réinitialisation de son mot de passe",
    },
    notification: {
      name: "notification",
      subject: "{{title}}",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h2>{{title}}</h2><p>Bonjour {{name}},</p><p>{{message}}</p><p style="color:#888;font-size:12px">Se désabonner : <a href="{{unsubscribeUrl}}">Cliquez ici</a></p></div>',
      textContent:
        "Bonjour {{name}},\n\n{{title}}\n\n{{message}}\n\nSe désabonner : {{unsubscribeUrl}}",
      description: "E-mail de notification générale",
    },
    "email-verification": {
      name: "email-verification",
      subject: "Vérifiez votre adresse e-mail",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Vérifiez votre adresse e-mail</h1><p>Bonjour {{name}},</p><p>Veuillez vérifier votre adresse e-mail :</p><p><a href="{{verificationUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Vérifier l\'e-mail</a></p><p>Ce lien expire dans <strong>{{expiresIn}}</strong>.</p></div>',
      textContent:
        "Bonjour {{name}},\n\nVérifiez votre adresse e-mail : {{verificationUrl}}\nCe lien expire dans {{expiresIn}}.",
      description: "Envoyé pour vérifier l'adresse e-mail d'un utilisateur",
    },
  },
  de: {
    welcome: {
      name: "welcome",
      subject: "Willkommen bei Trellis!",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Willkommen, {{name}}!</h1><p>Vielen Dank, dass Sie sich für <strong>Trellis</strong> entschieden haben.</p><p>Ihr Konto ist jetzt aktiv.</p></div>',
      textContent:
        "Willkommen, {{name}}!\n\nVielen Dank, dass Sie sich für Trellis entschieden haben.\nIhr Konto ist jetzt aktiv.",
      description: "Wird bei der Registrierung an neue Benutzer gesendet",
    },
    "password-reset": {
      name: "password-reset",
      subject: "Passwort-Zurücksetzungsanfrage",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Passwort zurücksetzen</h1><p>Hallo {{name}},</p><p>Wir haben eine Anfrage zum Zurücksetzen Ihres Passworts erhalten.</p><p><a href="{{resetUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">Passwort zurücksetzen</a></p><p>Dieser Link läuft in <strong>{{expiresIn}}</strong> ab.</p></div>',
      textContent:
        "Hallo {{name}},\n\nLink zum Zurücksetzen: {{resetUrl}}\nDieser Link läuft in {{expiresIn}} ab.",
      description:
        "Wird gesendet, wenn ein Benutzer das Passwort zurücksetzen möchte",
    },
    notification: {
      name: "notification",
      subject: "{{title}}",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h2>{{title}}</h2><p>Hallo {{name}},</p><p>{{message}}</p><p style="color:#888;font-size:12px">Abmelden: <a href="{{unsubscribeUrl}}">Hier klicken</a></p></div>',
      textContent:
        "Hallo {{name}},\n\n{{title}}\n\n{{message}}\n\nAbmelden: {{unsubscribeUrl}}",
      description: "Allgemeine Benachrichtigungs-E-Mail",
    },
    "email-verification": {
      name: "email-verification",
      subject: "Bestätigen Sie Ihre E-Mail-Adresse",
      htmlContent:
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><h1>Bestätigen Sie Ihre E-Mail</h1><p>Hallo {{name}},</p><p>Bitte bestätigen Sie Ihre E-Mail-Adresse:</p><p><a href="{{verificationUrl}}" style="display:inline-block;padding:10px 20px;background:#0066ff;color:#fff;text-decoration:none;border-radius:4px">E-Mail bestätigen</a></p><p>Dieser Link läuft in <strong>{{expiresIn}}</strong> ab.</p></div>',
      textContent:
        "Hallo {{name}},\n\nBestätigen Sie Ihre E-Mail: {{verificationUrl}}\nDieser Link läuft in {{expiresIn}} ab.",
      description:
        "Wird zur Bestätigung der E-Mail-Adresse eines Benutzers gesendet",
    },
  },
};

/**
 * Normalizes locale tag into base language (e.g., 'es-ES' -> 'es', 'FR' -> 'fr').
 * Returns 'en' if invalid or not provided.
 */
export function normalizeLocale(locale?: string | null): string {
  if (!locale || typeof locale !== "string") {
    return DEFAULT_LOCALE;
  }
  const cleaned = locale.trim().toLowerCase();
  const base = cleaned.split(/[-_]/)[0];
  return base || DEFAULT_LOCALE;
}

/**
 * Resolves an email template by name and preferred locale, falling back to English ('en')
 * if the template or locale is not found.
 */
export function getI18nTemplate(
  name: string,
  locale?: string | null,
): I18nEmailTemplate | undefined {
  const norm = normalizeLocale(locale);
  // Try requested locale
  if (I18N_TEMPLATES[norm] && I18N_TEMPLATES[norm][name]) {
    return I18N_TEMPLATES[norm][name];
  }
  // Try reading from filesystem if templates directory exists
  const fileTemplate = loadTemplateFromFile(name, norm);
  if (fileTemplate) {
    return fileTemplate;
  }

  // Gracefully fall back to English
  if (I18N_TEMPLATES[DEFAULT_LOCALE] && I18N_TEMPLATES[DEFAULT_LOCALE][name]) {
    return I18N_TEMPLATES[DEFAULT_LOCALE][name];
  }
  return loadTemplateFromFile(name, DEFAULT_LOCALE);
}

/**
 * Attempts to load HTML content from templates/{locale}/{name}.html from workspace root or module path.
 */
function loadTemplateFromFile(
  name: string,
  locale: string,
): I18nEmailTemplate | undefined {
  const possiblePaths = [
    path.resolve(process.cwd(), "templates", locale, `${name}.html`),
    path.resolve(__dirname, "..", "templates", locale, `${name}.html`),
    path.resolve(__dirname, locale, `${name}.html`),
  ];

  for (const filePath of possiblePaths) {
    try {
      if (fs.existsSync(filePath)) {
        const htmlContent = fs.readFileSync(filePath, "utf-8");
        // Combine with fallback metadata from dictionary
        const fallback = I18N_TEMPLATES[DEFAULT_LOCALE]?.[name];
        return {
          name,
          subject: fallback?.subject || name,
          htmlContent,
          textContent: fallback?.textContent,
          description: fallback?.description,
        };
      }
    } catch {
      // Continue search on error
    }
  }
  return undefined;
}
