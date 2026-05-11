import api from './api';
import { DBUser } from '@/types';

export const userService = {
  listAll: (): Promise<DBUser[]> =>
    api.get<DBUser[]>('/users').then((r) => r.data),

  listActive: (): Promise<DBUser[]> =>
    api.get<DBUser[]>('/users').then((r) => r.data.filter((u) => u.status === 'active')),

  listActiveEmployees: (): Promise<DBUser[]> =>
    api.get<DBUser[]>('/users').then((r) =>
      r.data.filter((u) => u.status === 'active' && u.role === 'employee')
    ),
};
