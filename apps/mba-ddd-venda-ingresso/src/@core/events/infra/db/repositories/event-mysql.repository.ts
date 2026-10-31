import { EntityManager } from '@mikro-orm/mysql';
import { Event, EventId } from '../../../domain/entities/event.entity';
import { EventSpotId } from '../../../domain/entities/event-spot';
import { IEventRepository } from '../../../domain/repositories/event-repository.interface';

export class EventMysqlRepository implements IEventRepository {
  constructor(private entityManager: EntityManager) {}

  async add(entity: Event): Promise<void> {
    this.entityManager.persist(entity);
  }

  async findById(id: string | EventId): Promise<Event> {
    return this.entityManager.findOne(Event, {
      id: typeof id === 'string' ? new EventId(id) : id,
    });
  }

  async findAll(): Promise<Event[]> {
    return this.entityManager.find(Event, {});
  }

  async findByEventSpotId(
    spot_id: string | EventSpotId,
  ): Promise<Event | null> {
    const event = await this.entityManager
      .createQueryBuilder(Event, 'event')
      .select('event.id')
      .join('event.sections', 'section')
      .join('section.spots', 'spot')
      .where({
        'spot.id':
          typeof spot_id === 'string' ? new EventSpotId(spot_id) : spot_id,
      })
      .execute('get');

    return event ? this.findById(event.id) : null;
  }

  async delete(entity: Event): Promise<void> {
    await this.entityManager.remove(entity);
  }
}
