import api from './api';

export interface TeamMemberLite {
  userId: string;
  profileId: string | null;
  firstName?: string;
  lastName?: string;
  email: string;
}

export const teamService = {
  async listMyMembers(): Promise<TeamMemberLite[]> {
    const res = await api.get('/teams/members/me');
    return res.data.map((m: any) => ({
      userId: m.userId,
      profileId: m.profileId || null,
      firstName: m.firstName,
      lastName: m.lastName,
      email: m.email,
    }));
  },
};
