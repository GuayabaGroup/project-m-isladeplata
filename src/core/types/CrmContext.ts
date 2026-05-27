export interface UpcomingAppointment {
  appointmentUuid: string;
  description: string;
  startAt: string;
}

export interface CrmContext {
  upcomingAppointments: UpcomingAppointment[];
  profileMeta: Record<string, unknown>;
}

export const EMPTY_CRM_CONTEXT: CrmContext = {
  upcomingAppointments: [],
  profileMeta: {},
};
