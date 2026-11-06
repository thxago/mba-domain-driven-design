import { ApplicationService } from '../../common/application/application.service';
import { EventSectionId } from '../domain/entities/event-section';
import { WaitingList } from '../domain/entities/waiting-list.entity';
import { ICustomerRepository } from '../domain/repositories/customer-repository.interface';
import { IEventRepository } from '../domain/repositories/event-repository.interface';
import { IWaitingListRepository } from '../domain/repositories/waiting-list-repository.interface';

export class WaitingListService {
  constructor(
    private waitingListRepo: IWaitingListRepository,
    private customerRepo: ICustomerRepository,
    private eventRepo: IEventRepository,
    private applicationService: ApplicationService,
  ) {}

  join(input: { customer_id: string; event_id: string; section_id: string }) {
    return this.applicationService.run(async () => {
      const customer = await this.customerRepo.findById(input.customer_id);
      if (!customer) {
        throw new Error('Customer not found');
      }

      const event = await this.eventRepo.findById(input.event_id);
      if (!event) {
        throw new Error('Event not found');
      }

      const sectionId = new EventSectionId(input.section_id);
      const section = event.sections.find((section) =>
        section.id.equals(sectionId),
      );
      if (!section) {
        throw new Error('Section not found');
      }

      const hasAvailableSpot = section.spots
        .values()
        .some((spot) => !spot.is_reserved);
      if (hasAvailableSpot) {
        throw new Error('Section is not sold out');
      }

      const list =
        (await this.waitingListRepo.findByEventAndSection(
          event.id,
          section.id,
        )) ??
        WaitingList.create({ event_id: event.id, section_id: section.id });
      const entry = list.join(customer.id);
      await this.waitingListRepo.add(list);
      return entry;
    });
  }

  async list(event_id: string, section_id: string) {
    const list = await this.waitingListRepo.findByEventAndSection(
      event_id,
      section_id,
    );
    return list
      ? [...list.entries.values()].sort((a, b) => a.position - b.position)
      : [];
  }
}