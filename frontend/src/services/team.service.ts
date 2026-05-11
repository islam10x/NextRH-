import api from './api';

export interface TeamMemberLite {
  userId: string;
  profileId: string | null;
  firstName?: string;
  lastName?: string;
  email: string;
}

export interface TeamInfo {
  teamId: string;
  managerId: string;
  teamName: string;
  teamFocus: string | null;
}

export interface ExternalTeamLite {
  teamId: string;
  teamName: string;
  managerId: string;
  managerName: string;
  managerEmail: string;
}

export interface EmployeeTeamInfo {
  teamId: string;
  teamName: string;
  teamFocus: string | null;
  managerName: string | null;
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

  async getMyTeam(): Promise<TeamInfo> {
    const res = await api.get('/teams/me');
    return {
      teamId: res.data.teamId,
      managerId: res.data.managerId,
      teamName: res.data.teamName || 'Team',
      teamFocus: res.data.teamFocus ?? null,
    };
  },

  async updateMyTeam(teamName: string, teamFocus?: string | null): Promise<TeamInfo> {
    const res = await api.patch('/teams/me', { teamName, teamFocus: teamFocus ?? null });
    return {
      teamId: res.data.teamId,
      managerId: res.data.managerId,
      teamName: res.data.teamName || 'Team',
      teamFocus: res.data.teamFocus ?? null,
    };
  },

  async getMyTeamInfo(): Promise<EmployeeTeamInfo | null> {
    try {
      const res = await api.get('/teams/my-team');
      if (!res.data) return null;
      return {
        teamId: res.data.teamId,
        teamName: res.data.teamName || 'Team',
        teamFocus: res.data.teamFocus ?? null,
        managerName: res.data.managerName ?? null,
      };
    } catch {
      return null;
    }
  },

  async listAllForBid(): Promise<{ teamId: string; teamName: string; memberUserIds: string[] }[]> {
    const res = await api.get('/teams/all');
    return res.data || [];
  },

  async listOtherTeams(): Promise<ExternalTeamLite[]> {
    const res = await api.get('/teams/other');
    return (res.data || []).map((t: any) => ({
      teamId: t.teamId,
      teamName: t.teamName || 'Team',
      managerId: t.managerId,
      managerName: t.managerName || t.managerEmail,
      managerEmail: t.managerEmail,
    }));
  },
};
