import { IDomainEventHandler } from '../../../common/application/domain-event-handler.interface';
import { DomainEventManager } from '../../../common/domain/domain-event-manager';
import { EventSpotReleased } from '../../domain/events/domain-events/event-spot-released.event';
import { IWaitingListRepository } from '../../domain/repositories/waiting-list-repository.interface';

export class NotifyWaitingCustomerOnSpotReleasedHandler
  implements IDomainEventHandler
{
  constructor(
    private waitingListRepo: IWaitingListRepository,
    private domainEventManager: DomainEventManager,
  ) {}

  async handle(event: EventSpotReleased): Promise<void> {
    const list = await this.waitingListRepo.findByEventAndSection(
      event.event_id,
      event.section_id,
    );
    if (!list) {
      return;
    }

    const previousEventCount = list.events.size;
    list.notifyFirstPending(event.spot_id);
    if (list.events.size === previousEventCount) {
      return;
    }

    await this.waitingListRepo.add(list);
    await this.domainEventManager.publish(list);
    await this.domainEventManager.publishForIntegrationEvent(list);
  }

  static listensTo(): string[] {
    return [EventSpotReleased.name];
  }
}