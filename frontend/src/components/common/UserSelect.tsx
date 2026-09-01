/**
 * UserSelect — a searchable user picker that queries the backend remotely.
 *
 * The admin user list is server-paginated (it can't load 1K-10K users), so this
 * dropdown does NOT load the full list: once the operator types `minChars`+
 * characters it debounces and calls the paginated users endpoint with a search
 * term (`userManagementService.searchUsers`). The selected value is just the
 * username string; an optional "All Users" sentinel (value `''`) can be shown.
 *
 * Drop-in replacement for the previous `react-select` <Select> fed by a
 * client-side userOptions list.
 */

import { useCallback, useMemo, useRef } from 'react';
import AsyncSelect from 'react-select/async';
import type { SingleValue } from 'react-select';
import { userManagementService } from '@/services/admin/v2AdminService';

export interface UserOption {
  value: string; // username; '' = the All sentinel
  label: string;
}

export interface UserSelectProps {
  /** Selected username; '' selects the All option (when shown). */
  value: string;
  /** Called with the selected username ('' when All / cleared). */
  onChange: (username: string) => void;
  /** Prepend an "All Users" sentinel option (value ''). Default true. */
  includeAllOption?: boolean;
  /** Label for the All sentinel. Default "All Users". */
  allOptionLabel?: string;
  placeholder?: string;
  isDisabled?: boolean;
  /** Minimum characters before a remote search fires. Default 2. */
  minChars?: number;
}

const formatUserLabel = (u: { username: string; fullName?: string; name?: string }) =>
  `${u.fullName || u.name || u.username} (${u.username})`;

const UserSelect: React.FC<UserSelectProps> = ({
  value,
  onChange,
  includeAllOption = true,
  allOptionLabel = 'All Users',
  placeholder = 'Search users…',
  isDisabled = false,
  minChars = 2,
}) => {
  // Cache username -> label learned from searches so the selected value keeps a
  // human-readable label after the menu closes (AsyncSelect needs the full
  // option object, not just the id, to render the current selection).
  const labelCache = useRef<Record<string, string>>({});
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadOptions = useCallback((input: string): Promise<UserOption[]> => {
    const base: UserOption[] = includeAllOption ? [{ value: '', label: allOptionLabel }] : [];
    const trimmed = input.trim();
    if (trimmed.length < minChars) {
      return Promise.resolve(base);
    }
    return new Promise<UserOption[]>((resolve) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        userManagementService
          .searchUsers(trimmed, 20)
          .then((users) => {
            const opts = users.map((u) => {
              const label = formatUserLabel(u);
              labelCache.current[u.username] = label;
              return { value: u.username, label };
            });
            resolve([...base, ...opts]);
          })
          .catch(() => resolve(base));
      }, 300);
    });
  }, [includeAllOption, allOptionLabel, minChars]);

  const selectedOption: UserOption | null = useMemo(() => {
    if (!value) {
      return includeAllOption ? { value: '', label: allOptionLabel } : null;
    }
    return { value, label: labelCache.current[value] || value };
  }, [value, includeAllOption, allOptionLabel]);

  return (
    <AsyncSelect<UserOption, false>
      cacheOptions
      defaultOptions={includeAllOption ? [{ value: '', label: allOptionLabel }] : false}
      loadOptions={loadOptions}
      value={selectedOption}
      onChange={(opt: SingleValue<UserOption>) => onChange(opt?.value ?? '')}
      isSearchable
      isClearable={!includeAllOption}
      isDisabled={isDisabled}
      placeholder={placeholder}
      classNamePrefix="react-select"
      noOptionsMessage={({ inputValue }) =>
        inputValue && inputValue.trim().length >= minChars
          ? 'No users found'
          : `Type ${minChars}+ characters to search`}
      styles={{
        control: (base) => ({ ...base, minHeight: '31px', fontSize: '0.875rem' }),
        menu: (base) => ({ ...base, fontSize: '0.875rem', zIndex: 9 }),
      }}
    />
  );
};

export default UserSelect;
