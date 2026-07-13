import { BaseRepository } from "../../shared/repositories/BaseRepository";
import { TicketEventEntity } from "../../domain/entities/TicketEventEntity";
import { Ticket } from "../../domain/entities/Ticket";

export class PostgresTicketEventRepository extends BaseRepository<TicketEventEntity, number> {
  async findById(id: number): Promise<TicketEventEntity | null> {
    const { rows } = await this.db.query(
      "SELECT * FROM ticket_events WHERE id = $1 LIMIT 1",
      [id]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return new TicketEventEntity({
      id: r.id,
      ticketId: r.ticket_id,
      eventType: r.event_type,
      actor: r.actor,
      source: r.source,
      correlationId: r.correlation_id || undefined,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      createdAt: new Date(r.created_at),
    });
  }

  async findByTicketId(ticketId: number): Promise<TicketEventEntity[]> {
    const { rows } = await this.db.query(
      "SELECT * FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at ASC",
      [ticketId]
    );
    return rows.map((r) => {
      return new TicketEventEntity({
        id: r.id,
        ticketId: r.ticket_id,
        eventType: r.event_type,
        actor: r.actor,
        source: r.source,
        correlationId: r.correlation_id || undefined,
        payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
        createdAt: new Date(r.created_at),
      });
    });
  }

  async save(entity: TicketEventEntity): Promise<TicketEventEntity> {
    const { rows } = await this.db.query(
      `INSERT INTO ticket_events (ticket_id, event_type, actor, source, correlation_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
       RETURNING id`,
      [
        entity.ticketId,
        entity.eventType,
        entity.actor,
        entity.source,
        entity.correlationId || null,
        JSON.stringify(entity.payload),
        entity.createdAt ? entity.createdAt.toISOString() : null,
      ]
    );
    return new TicketEventEntity({
      ...entity,
      id: rows[0].id,
    });
  }

  /**
   * Persists all accumulated domain events directly from the Ticket aggregate.
   */
  async saveEvents(
    ticket: Ticket,
    correlationId: string,
    actor: string,
    source: string
  ): Promise<void> {
    for (const event of ticket.domainEvents) {
      const eventType = event.constructor.name;
      // Exclude base occurredAt property from JSON payload to keep schema clean
      const { occurredAt, ...payload } = event as any;

      await this.save(
        new TicketEventEntity({
          id: 0,
          ticketId: ticket.id,
          eventType,
          actor,
          source,
          correlationId,
          payload,
          createdAt: occurredAt,
        })
      );
    }
  }
}
