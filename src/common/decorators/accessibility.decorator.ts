import { SetMetadata } from "@nestjs/common";

export const ACCESSIBILITY_METADATA = "accessibility";

export interface AccessibilityOptions {
  description: string;
  fieldLabels?: Record<string, string>;
  errorMessages?: Record<string, string>;
  keyboardNavigable?: boolean;
  screenReaderFriendly?: boolean;
}

export const Accessibility = (options: AccessibilityOptions) => SetMetadata(ACCESSIBILITY_METADATA, options);

export function getAccessibilityOptions(target: any): AccessibilityOptions | undefined {
  const metadata = Reflect.getMetadata(ACCESSIBILITY_METADATA, target);
  return metadata || undefined;
}
