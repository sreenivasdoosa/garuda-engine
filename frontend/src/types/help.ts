/**
 * Help documentation types
 * Used for field-level help drawer across the admin panel
 */

export interface HelpArticle {
  fieldKey: string;
  title: string;
  category: string;
  description: string[];
  example?: {
    title: string;
    content: string;
  };
  defaultValue?: string;
  relatedFields?: string[];
  warning?: string;
  validValues?: string[];
}
