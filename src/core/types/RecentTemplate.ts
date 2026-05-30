/**
 * Template proactivo enviado al usuario (recordatorio de turno, confirmación,
 * cancelación, etc.), leído de Guacuco (`template_send_log`) por el pre-grafo.
 *
 * Da contexto al supervisor para interpretar respuestas de TEXTO LIBRE
 * relacionadas al último template recibido (ej. un "sí dale" tras un
 * recordatorio de turno). Los taps de botón estructurados ya se resuelven por
 * `detectButtonShortcut`; esto cubre el hueco de las respuestas escritas.
 *
 * Inmutable durante el turno: lo setea el pre-grafo y en el state es
 * replace-only (carga única por turno, como `crmContext`/`catalog`).
 *
 * Guacuco NO persiste el body renderizado del template, solo el `templateName`
 * + los `parameters` (valores sustituidos: fecha, hora, servicio…). Con eso
 * alcanza para que el LLM infiera a qué está respondiendo el usuario.
 */
export interface RecentTemplate {
  templateName: string;
  userType: string;
  langCode: string;
  parameters: unknown[];
  channelPhoneNumberId: string | null;
  metaMessageId: string | null;
  status: 'sent' | 'failed';
  sourceComponent: string;
  /**
   * `platform_id` extraído de `metadata` (si presente). Lo usa el pre-grafo para
   * el filtrado cross-platform (mismo teléfono puede recibir templates de
   * Divapp/Groomia/Allia). `null` cuando el log no lo trae.
   */
  platformId: number | null;
  /**
   * `appointment_uuid` del turno asociado al template, extraído de `metadata`.
   * Es el hilo que permite resolver QUÉ turno afectar cuando el usuario toca un
   * botón quick-reply del template (Cancelar/Confirmar/Reagendar): el payload del
   * botón es estático (el título), así que el uuid se resuelve cruzando el
   * `contextMessageId` del tap contra `metaMessageId` y leyendo este campo. Misma
   * fuente que el resolver de Guacuco (`metadata->>'appointment_uuid'`). `null`
   * cuando el log no lo trae. Ver `resolveTemplateAppointmentUuid`.
   */
  appointmentUuid: string | null;
  createdAt: string;
}
