import { EntityManager } from '@mikro-orm/mysql';
import { EventSectionId } from '../../../domain/entities/event-section';
import { EventId } from '../../../domain/entities/event.entity';
import {
  WaitingList,
  WaitingListId,
} from '../../../domain/entities/waiting-list.entity';
import { IWaitingListRepository } from '../../../domain/repositories/waiting-list-repository.interface';

export class WaitingListMysqlRepository implements IWaitingListRepository {
  constructor(private entityManager: EntityManager) {}

  async add(entity: WaitingList): Promise<void> {
    this.entityManager.persist(entity);
  }

  findById(id: string | WaitingListId): Promise<WaitingList | null> {
    return this.entityManager.findOne(WaitingList, {
      id: typeof id === 'string' ? new WaitingListId(id) : id,
    });
  }

  findByEventAndSection(
    event_id: string | EventId,
    section_id: string | EventSectionId,
  ): Promise<WaitingList | null> {
    return this.entityManager.findOne(WaitingList, {
      event_id: typeof event_id === 'string' ? new EventId(event_id) : event_id,
      section_id:
        typeof section_id === 'string'
          ? new EventSectionId(section_id)
          : section_id,
    });
  }

  findAll(): Promise<WaitingList[]> {
    return this.entityManager.find(WaitingList, {});
  }

  async delete(entity: WaitingList): Promise<void> {
    this.entityManager.remove(entity);
  }
}