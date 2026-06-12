// Minimal User shape that the dashboard + nav need to render. Mirrors the
// shape in frontend2/src/types/index.ts but with only the fields we
// actually consume in step 4 / 6 / 7. Add fields here as pages start
// needing them.

export type UserRole = 'EMPLOYEE' | 'MANAGER' | 'VIEWER' | 'ADMIN' | 'PLATFORM_ADMIN';

export interface User {
  id: number;
  email: string;
  username: string;
  full_name: string;
  title?: string | null;
  department?: string | null;
  timezone?: string | null;
  role: UserRole;
  roles?: UserRole[];
  is_active: boolean;
  has_changed_password: boolean;
  email_verified: boolean;
  can_review?: boolean;
  is_external?: boolean;
  tenant_id: number | null;
  manager_id?: number | null;
  preferences?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  user: User;
}
