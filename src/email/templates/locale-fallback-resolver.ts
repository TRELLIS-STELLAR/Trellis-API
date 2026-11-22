import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  DEFAULT_LOCALE,
  getI18nTemplate,
  I18N_TEMPLATES,
  I18nEmailTemplate,
} from "./template-dictionary";

export interface LocaleFallbackOptions {
  /** If true, fallback is prohibited and missing exact locale throws an error */
  strict?: boolean;
  /** Custom fallback chain to override standard language-base -> default fallback */
  customChain?: string[];
  /** Default system fallback locale (defaults to 'en') */
  defaultLocale?: string;
  /** Custom tenant-level fallback locale */
  tenantFallbackLocale?: string;
}

export interface ResolvedTemplate {
  name: string;
  template: I18nEmailTemplate;
  requestedLocale: string;
  resolvedLocale: string;
  fallbackUsed: boolean;
  chainTraversed: string[];
  fromCache: boolean;
}

/**
 * Normalizes BCP-47 / RFC-5646 language tags into lowercase hyphenated tokens.
 * E.g., "en_US" -> "en-us", "FR-ca" -> "fr-ca".
 */
export function normalizeLocaleTag(locale?: string | null): string {
  if (!locale || typeof locale !== "string") {
    return DEFAULT_LOCALE;
  }
  const trimmed = locale.trim().toLowerCase().replace(/_/g, "-");
  return trimmed || DEFAULT_LOCALE;
}

/**
 * Generates an ordered fallback chain for a requested locale.
 * Example for 'fr-ca': ['fr-ca', 'fr', 'en']
 * Example for 'zh-hant-hk': ['zh-hant-hk', 'zh-hant', 'zh', 'en']
 */
export function buildLocaleFallbackChain(
  requestedLocale?: string | null,
  options?: { defaultLocale?: string; tenantFallbackLocale?: string },
): string[] {
  const norm = normalizeLocaleTag(requestedLocale);
  const def = normalizeLocaleTag(options?.defaultLocale || DEFAULT_LOCALE);
  const tenantDef = options?.tenantFallbackLocale
    ? normalizeLocaleTag(options.tenantFallbackLocale)
    : undefined;

  const chain: string[] = [norm];

  // Progressive decomposition: 'a-b-c' -> 'a-b' -> 'a'
  const parts = norm.split("-");
  for (let i = parts.length - 1; i >= 1; i--) {
    const parent = parts.slice(0, i).join("-");
    if (!chain.includes(parent)) {
      chain.push(parent);
    }
  }

  // Tenant default if specified
  if (tenantDef && !chain.includes(tenantDef)) {
    chain.push(tenantDef);
    const tenantBase = tenantDef.split("-")[0];
    if (!chain.includes(tenantBase)) {
      chain.push(tenantBase);
    }
  }

  // Final system default
  if (!chain.includes(def)) {
    chain.push(def);
    const defBase = def.split("-")[0];
    if (!chain.includes(defBase)) {
      chain.push(defBase);
    }
  }

  return chain;
}

@Injectable()
export class LocaleFallbackResolver {
  private readonly logger = new Logger(LocaleFallbackResolver.name);
  private readonly templateRegistry = new Map<string, Map<string, I18nEmailTemplate>>();
  private readonly resolutionCache = new Map<string, ResolvedTemplate>();
  private readonly cacheMaxSize = 500;

  constructor() {
    // Seed in-memory registry from standard I18N_TEMPLATES
    for (const [locale, templates] of Object.entries(I18N_TEMPLATES)) {
      const localeKey = normalizeLocaleTag(locale);
      if (!this.templateRegistry.has(localeKey)) {
        this.templateRegistry.set(localeKey, new Map());
      }
      const map = this.templateRegistry.get(localeKey)!;
      for (const [name, tpl] of Object.entries(templates)) {
        map.set(name, tpl);
      }
    }
  }

  /**
   * Registers or updates a template for a specific locale in memory.
   */
  registerTemplate(locale: string, template: I18nEmailTemplate): void {
    const norm = normalizeLocaleTag(locale);
    if (!this.templateRegistry.has(norm)) {
      this.templateRegistry.set(norm, new Map());
    }
    this.templateRegistry.get(norm)!.set(template.name, template);
    this.invalidateCache(template.name);
  }

  /**
   * Resolves a template following the locale fallback chain.
   */
  resolveTemplate(
    templateName: string,
    requestedLocale?: string | null,
    options: LocaleFallbackOptions = {},
  ): ResolvedTemplate {
    if (!templateName || typeof templateName !== "string") {
      throw new NotFoundException("Template name must be a non-empty string");
    }

    const normRequested = normalizeLocaleTag(requestedLocale);
    const cacheKey = `${templateName}:${normRequested}:${options.strict ? "strict" : "loose"}:${options.tenantFallbackLocale || ""}`;

    const cached = this.resolutionCache.get(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const chain = options.customChain
      ? options.customChain.map((loc) => normalizeLocaleTag(loc))
      : buildLocaleFallbackChain(normRequested, {
          defaultLocale: options.defaultLocale,
          tenantFallbackLocale: options.tenantFallbackLocale,
        });

    const traversedChain: string[] = [];

    for (let i = 0; i < chain.length; i++) {
      const currentLocale = chain[i];
      traversedChain.push(currentLocale);

      // In strict mode, only evaluate the first locale in chain
      if (options.strict && i > 0) {
        break;
      }

      // Check registry
      const registered = this.templateRegistry.get(currentLocale)?.get(templateName);
      if (registered) {
        const resolved: ResolvedTemplate = {
          name: templateName,
          template: registered,
          requestedLocale: normRequested,
          resolvedLocale: currentLocale,
          fallbackUsed: currentLocale !== normRequested,
          chainTraversed: traversedChain,
          fromCache: false,
        };
        this.setCache(cacheKey, resolved);
        return resolved;
      }

      // Check dictionary helper
      const dictTemplate = getI18nTemplate(templateName, currentLocale);
      if (dictTemplate) {
        const resolved: ResolvedTemplate = {
          name: templateName,
          template: dictTemplate,
          requestedLocale: normRequested,
          resolvedLocale: currentLocale,
          fallbackUsed: currentLocale !== normRequested,
          chainTraversed: traversedChain,
          fromCache: false,
        };
        this.setCache(cacheKey, resolved);
        return resolved;
      }
    }

    if (options.strict) {
      throw new NotFoundException(
        `Template "${templateName}" not found in requested locale "${normRequested}" (strict resolution enforced)`,
      );
    }

    throw new NotFoundException(
      `Template "${templateName}" not found in requested locale "${normRequested}" or any fallback locale (${traversedChain.join(
        " -> ",
      )})`,
    );
  }

  /**
   * Invalidates cached entries for a template name.
   */
  invalidateCache(templateName?: string): void {
    if (!templateName) {
      this.resolutionCache.clear();
      return;
    }
    for (const key of Array.from(this.resolutionCache.keys())) {
      if (key.startsWith(`${templateName}:`)) {
        this.resolutionCache.delete(key);
      }
    }
  }

  private setCache(key: string, value: ResolvedTemplate): void {
    if (this.resolutionCache.size >= this.cacheMaxSize) {
      const oldestKey = this.resolutionCache.keys().next().value;
      if (oldestKey) {
        this.resolutionCache.delete(oldestKey);
      }
    }
    this.resolutionCache.set(key, value);
  }
}
