import { DomainEventManager } from '../../../common/domain/domain-event-manager';
import { CustomerId } from '../../domain/entities/customer.entity';
import { EventSpotId } from '../../domain/entities/event-spot';
import { Event } from '../../domain/entities/event.entity';
import { OrderId, OrderStatus } from '../../domain/entities/order.entity';
import { PartnerId } from '../../domain/entities/partner.entity';
import { SpotReservation } from '../../domain/entities/spot-reservation.entity';
import { OrderCancelled } from '../../domain/events/domain-events/order-cancelled.event';
import { IEventRepository } from '../../domain/repositories/event-repository.interface';
import { ISpotReservationRepository } from '../../domain/repositories/spot-reservation-repository.interface';
import { ReleaseSpotOnOrderCancelledHandler } from './release-spot-on-order-cancelled.handler';

describe('ReleaseSpotOnOrderCancelledHandler', () => {
  let eventRepo: jest.Mocked<IEventRepository>;
  let reservationRepo: jest.Mocked<ISpotReservationRepository>;
  let manager: DomainEventManager;
  let handler: ReleaseSpotOnOrderCancelledHandler;
  let cancelled: OrderCancelled;
  let aggregate: Event;

  beforeEach(() => {
    eventRepo = {
      add: jest.fn(),
      findById: jest.fn(),
      findByEventSpotId: jest.fn(),
      findAll: jest.fn(),
      delete: jest.fn(),
    };
    reservationRepo = {
      add: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
      delete: jest.fn(),
    };
    manager = new DomainEventManager();
    jest.spyOn(manager, 'publish').mockResolvedValue(undefined);
    handler = new ReleaseSpotOnOrderCancelledHandler(
      eventRepo,
      reservationRepo,
      manager,
    );
    cancelled = new OrderCancelled(
      new OrderId(),
      OrderStatus.CANCELLED,
      new EventSpotId(),
    );
    aggregate = Event.create({
      name: 'Event',
      date: new Date(),
      partner_id: new PartnerId(),
    });
    jest.spyOn(aggregate, 'markSpotAsAvailable').mockImplementation(jest.fn());
    eventRepo.findByEventSpotId.mockResolvedValue(aggregate);
  });

  test('delegates release, deletes the matching reservation, persists and publishes', async () => {
    const reservation = SpotReservation.create({
      spot_id: cancelled.event_spot_id,
      customer_id: new CustomerId(),
    });
    reservationRepo.findById.mockResolvedValue(reservation);

    await handler.handle(cancelled);

    expect(eventRepo.findByEventSpotId).toHaveBeenCalledWith(
      cancelled.event_spot_id,
    );
    expect(aggregate.markSpotAsAvailable).toHaveBeenCalledWith(
      cancelled.event_spot_id,
    );
    expect(reservationRepo.findById).toHaveBeenCalledWith(
      cancelled.event_spot_id,
    );
    expect(reservationRepo.delete).toHaveBeenCalledWith(reservation);
    expect(eventRepo.add).toHaveBeenCalledWith(aggregate);
    expect(manager.publish).toHaveBeenCalledWith(aggregate);
    expect(eventRepo.add.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(manager.publish).mock.invocationCallOrder[0],
    );
  });

  test('releases the spot when no reservation exists', async () => {
    reservationRepo.findById.mockResolvedValue(null);

    await handler.handle(cancelled);

    expect(reservationRepo.delete).not.toHaveBeenCalled();
    expect(eventRepo.add).toHaveBeenCalledWith(aggregate);
    expect(manager.publish).toHaveBeenCalledWith(aggregate);
  });

  test('fails for an unknown event without deleting or publishing', async () => {
    eventRepo.findByEventSpotId.mockResolvedValue(null);

    await expect(handler.handle(cancelled)).rejects.toThrow('Event not found');

    expect(aggregate.markSpotAsAvailable).not.toHaveBeenCalled();
    expect(reservationRepo.findById).not.toHaveBeenCalled();
    expect(reservationRepo.delete).not.toHaveBeenCalled();
    expect(eventRepo.add).not.toHaveBeenCalled();
    expect(manager.publish).not.toHaveBeenCalled();
  });
});