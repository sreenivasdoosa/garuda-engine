import type { HelpArticle } from '@/types/help';

const fq = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const faqHelpContent: Record<string, HelpArticle> = {
  'faq.question': fq({
    fieldKey: 'faq.question',
    title: 'Question',
    category: 'FAQ',
    description: [
      'The **question text** displayed to users in the FAQ section. Write clear, concise questions that users are likely to search for.',
      'Questions are searchable — users can filter FAQs by typing keywords that match the question text.',
    ],
    example: {
      title: 'Example',
      content:
        '"How do I add a new broker account?" or "What happens when the daily risk limit is reached?"',
    },
  }),

  'faq.answer': fq({
    fieldKey: 'faq.answer',
    title: 'Answer',
    category: 'FAQ',
    description: [
      'The **answer text** providing a detailed response to the question. Supports plain text — write clear, step-by-step instructions where applicable.',
      'Answers are also searchable, so include relevant keywords and terminology that users might search for.',
    ],
    example: {
      title: 'Example',
      content:
        '"To add a new broker account, go to User Brokers page, click Add User Broker, select the broker, enter your API credentials, and save. The system will validate the credentials on the next login cycle."',
    },
  }),
};
