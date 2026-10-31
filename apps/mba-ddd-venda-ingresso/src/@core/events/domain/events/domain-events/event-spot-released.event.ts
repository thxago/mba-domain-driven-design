import { IDomainEvent } from '../../../../common/domain/domain-event';
import { EventSectionId } from '../../entities/event-section';
import { EventSpotId } from '../../entities/event-spot';
import { EventId } from '../../entities/event.entity';

export class EventSpotReleased implements IDomainEvent {
  readonly event_version: number = 1;
  readonly occurred_on: Date;
  readonly event_id: EventId;

  constructor(
    readonly aggregate_id: EventId,
    readonly section_id: EventSectionId,
    readonly spot_id: EventSpotId,
  ) {
    this.event_id = aggregate_id;
    this.occurred_on = new Date();
  }
}