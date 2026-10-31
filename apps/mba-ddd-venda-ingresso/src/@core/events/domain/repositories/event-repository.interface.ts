import { IRepository } from '../../../common/domain/repository-interface';
import { Event } from '../entities/event.entity';
import { EventSpotId } from '../entities/event-spot';

export interface IEventRepository extends IRepository<Event> {
  findByEventSpotId(spot_id: string | EventSpotId): Promise<Event | null>;
}
