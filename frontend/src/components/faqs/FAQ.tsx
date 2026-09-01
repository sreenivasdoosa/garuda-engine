/**
 * FAQ Component
 * Simple display component for a single FAQ
 * Used for accordion/expandable FAQ display
 */

import { useState } from 'react';
import { Card, Collapse } from '@/components/ui/rbShim';
import { BsChevronDown, BsChevronUp } from 'react-icons/bs';
import type { FAQ as FAQType } from '@/types/system';

export interface FAQProps {
  /** FAQ data */
  faq: FAQType;
  /** Initially expanded */
  defaultExpanded?: boolean;
}

const FAQ: React.FC<FAQProps> = ({ faq, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Card className="mb-2">
      <Card.Header
        className="flex justify-between items-center cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        <span className="font-medium">{faq.question}</span>
        {expanded ? <BsChevronUp /> : <BsChevronDown />}
      </Card.Header>
      <Collapse in={expanded}>
        <div>
          <Card.Body>
            <div style={{ whiteSpace: 'pre-wrap' }}>{faq.answer}</div>
          </Card.Body>
        </div>
      </Collapse>
    </Card>
  );
};

export default FAQ;
