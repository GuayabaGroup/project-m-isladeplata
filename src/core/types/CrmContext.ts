export interface UpcomingAppointment {
  appointmentUuid: string;
  description: string;
  /**
   * Inicio del turno. Opcional: el identity resolve de Guacuco
   * (`profileData.appointments`) no lo expone. Cuando Parguito aporte el dato
   * sí vendrá poblado. Los nodos que lo muestran ya lo tratan como opcional.
   */
  startAt?: string;
}

export interface CrmContext {
  upcomingAppointments: UpcomingAppointment[];
  profileMeta: Record<string, unknown>;
}

export const EMPTY_CRM_CONTEXT: CrmContext = {
  upcomingAppointments: [],
  profileMeta: {},
};
