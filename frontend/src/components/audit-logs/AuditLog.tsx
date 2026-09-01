/**
 * AuditLog Component
 * Modal for viewing a single audit log entry
 * Reusable across Admin portals
 */

import { useMemo } from 'react';
import { Modal, Row, Col, Button, Badge } from '@/components/ui/rbShim';
import { BsClipboardCheck } from 'react-icons/bs';
import type { AuditLog as AuditLogType } from '@/types/system';

export interface AuditLogProps {
  /** Audit log entry */
  log: AuditLogType | null;
  /** Whether the modal is visible */
  show: boolean;
  /** Close modal callback */
  onClose: () => void;
}

const ACTION_COLORS: Record<string, string> = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'danger',
  ENABLE: 'primary',
  DISABLE: 'warning',
  LOGIN: 'success',
  LOGOUT: 'secondary',
};

const IGNORED_DIFF_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'createdOn',
  'updatedOn',
  'lastUpdatedAt',
  'sessionCreatedOn',
  'changedTimestamp',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const flattenObject = (value: unknown, prefix = ''): Record<string, string> => {
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return prefix ? { [prefix]: value == null ? '' : String(value) } : {};
  }

  if (Array.isArray(value)) {
    return prefix
      ? { [prefix]: JSON.stringify(value) }
      : { root: JSON.stringify(value) };
  }

  return Object.entries(value).reduce<Record<string, string>>((acc, [key, nestedValue]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(nestedValue)) {
      Object.assign(acc, flattenObject(nestedValue, nextPrefix));
    } else if (Array.isArray(nestedValue)) {
      acc[nextPrefix] = JSON.stringify(nestedValue);
    } else {
      acc[nextPrefix] = nestedValue == null ? '' : String(nestedValue);
    }

    return acc;
  }, {});
};

const AuditLog: React.FC<AuditLogProps> = ({
  log,
  show,
  onClose,
}) => {
  // Parse JSON strings for oldData and newData
  const parsedOldData = useMemo(() => {
    if (!log?.oldData) return null;
    try {
      return JSON.parse(log.oldData);
    } catch {
      return log.oldData;
    }
  }, [log?.oldData]);

  const parsedNewData = useMemo(() => {
    if (!log?.newData) return null;
    try {
      return JSON.parse(log.newData);
    } catch {
      return log.newData;
    }
  }, [log?.newData]);

  const changedFields = useMemo(() => {
    if (!parsedOldData || !parsedNewData) return [];
    if ((!isPlainObject(parsedOldData) && !Array.isArray(parsedOldData)) || (!isPlainObject(parsedNewData) && !Array.isArray(parsedNewData))) {
      return [];
    }

    const oldFlat = flattenObject(parsedOldData);
    const newFlat = flattenObject(parsedNewData);
    const allKeys = Array.from(new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)])).sort();

    return allKeys
      .filter((key) => !IGNORED_DIFF_FIELDS.has(key.split('.').pop() || key))
      .filter((key) => (oldFlat[key] ?? '') !== (newFlat[key] ?? ''))
      .map((key) => ({
        key,
        oldValue: oldFlat[key] ?? '-',
        newValue: newFlat[key] ?? '-',
      }));
  }, [parsedNewData, parsedOldData]);

  if (!log) return null;

  return (
    <Modal show={show} onHide={onClose} size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="flex items-center gap-2">
          <BsClipboardCheck />
          Audit Log Details
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Row className="">
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Entity Type</label>
            <div><Badge bg="primary">{log.entityType}</Badge></div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Action</label>
            <div><Badge bg={ACTION_COLORS[log.action] || 'secondary'}>{log.action}</Badge></div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Entity ID</label>
            <div><code>{log.entityId}</code></div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Entity Name</label>
            <div className="font-medium">{log.entityName || '-'}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Changed By</label>
            <div className="font-medium">{log.changedBy}</div>
          </Col>
          <Col md={6}>
            <label className="text-ink-soft text-[0.875em]">Timestamp</label>
            <div>{new Date(log.changedTimestamp).toLocaleString()}</div>
          </Col>
          {(parsedOldData && parsedNewData) && (
            <Col xs={12}>
              <label className="text-ink-soft text-[0.875em]">Changed Fields</label>
              {changedFields.length > 0 ? (
                <div className="border rounded-md text-[0.875em]" style={{ maxHeight: '300px', overflow: 'auto' }}>
                  <table className="w-full text-sm [&_thead_th]:bg-raised [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-ink-faint [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_td]:text-ink [&_tbody_tr]:border-b [&_tbody_tr]:border-hairline [&_th]:!py-1.5 [&_td]:!py-1.5 [&_th]:!px-2 [&_td]:!px-2 mb-0 align-middle">
                    <thead className="bg-raised" style={{ position: 'sticky', top: 0 }}>
                      <tr>
                        <th style={{ width: '24%' }}>Field</th>
                        <th style={{ width: '38%' }}>Old Value</th>
                        <th style={{ width: '38%' }}>New Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changedFields.map((field) => (
                        <tr key={field.key}>
                          <td><code>{field.key}</code></td>
                          <td className="text-danger-600 dark:text-danger-400"><pre className="mb-0 whitespace-normal">{field.oldValue}</pre></td>
                          <td className="text-success-500 dark:text-success-400"><pre className="mb-0 whitespace-normal">{field.newValue}</pre></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="border rounded-md bg-raised px-4 py-2 text-[0.875em] text-ink-soft">
                  No effective changes found between old and new data after ignoring audit timestamp fields.
                </div>
              )}
            </Col>
          )}
          {parsedOldData && (
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">Old Data</label>
              <div className="bg-raised p-2 rounded-md text-[0.875em]" style={{ maxHeight: '250px', overflow: 'auto' }}>
                <pre className="mb-0">{typeof parsedOldData === 'string' ? parsedOldData : JSON.stringify(parsedOldData, null, 2)}</pre>
              </div>
            </Col>
          )}
          {parsedNewData && (
            <Col md={6}>
              <label className="text-ink-soft text-[0.875em]">New Data</label>
              <div className="bg-raised p-2 rounded-md text-[0.875em]" style={{ maxHeight: '250px', overflow: 'auto' }}>
                <pre className="mb-0">{typeof parsedNewData === 'string' ? parsedNewData : JSON.stringify(parsedNewData, null, 2)}</pre>
              </div>
            </Col>
          )}
        </Row>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </Modal.Footer>
    </Modal>
  );
};

export default AuditLog;
