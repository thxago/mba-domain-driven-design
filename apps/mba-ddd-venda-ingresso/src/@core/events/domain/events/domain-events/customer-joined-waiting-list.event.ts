import { IDomainEvent } from '../../../../common/domain/domain-event';
import { CustomerId } from '../../entities/customer.entity';
import { EventSectionId } from '../../entities/event-section';
import { EventId } from '../../entities/event.entity';
import { WaitingListId } from '../../entities/waiting-list.entity';

export class CustomerJoinedWaitingList implements IDomainEvent {
  readonly event_version: number = 1;
  readonly occurred_on: Date;

  constructor(
    readonly aggregate_id: WaitingListId,
    readonly customer_id: CustomerId,
    readonly event_id: EventId,
    readonly section_id: EventSectionId,
  ) {
    this.occurred_on = new Date();
  }
}