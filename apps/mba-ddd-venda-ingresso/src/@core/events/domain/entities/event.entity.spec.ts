import { EventSpotReleased } from '../events/domain-events/event-spot-released.event';
import { EventSection } from './event-section';
import { EventSpot, EventSpotId } from './event-spot';
import { Event } from './event.entity';
import { PartnerId } from './partner.entity';

jest.mock('../../../common/domain/my-collection', () => ({
  MyCollectionFactory: {
    create: () => {
      const items = new Set<object>();
      return {
        add: (...entries: object[]) =>
          entries.forEach((entry) => items.add(entry)),
        remove: (...entries: object[]) =>
          entries.forEach((entry) => items.delete(entry)),
        find: (predicate: (item: object) => boolean) =>
          [...items].find(predicate),
        forEach: (callback: (item: object, index: number) => void) =>
          [...items].forEach(callback),
        map: (callback: (item: object, index: number) => unknown) =>
          [...items].map(callback),
        removeAll: () => items.clear(),
        count: () => items.size,
        get size() {
          return items.size;
        },
        values: () => [...items],
        getItems: () => [...items],
        [Symbol.iterator]: () => items[Symbol.iterator](),
      };
    },
  },
}));

describe('Spot release', () => {
  test('makes a reserved spot available without changing its other properties', () => {
    const spot = EventSpot.create();
    spot.changeLocation('A1');
    spot.publish();
    spot.markAsReserved();

    spot.markAsAvailable();

    expect(spot.is_reserved).toBe(false);
    expect(spot.is_published).toBe(true);
    expect(spot.location).toBe('A1');
  });

  test('releases a spot through its section', () => {
    const section = EventSection.create({
      name: 'Section',
      total_spots: 1,
      price: 200,
    });
    const spot = section.spots.values()[0];
    section.markSpotAsReserved(spot.id);

    section.markSpotAsAvailable(new EventSpotId(spot.id.value));

    expect(spot.is_reserved).toBe(false);
  });

  test('rejects releasing a spot that does not belong to the section', () => {
    const section = EventSection.create({
      name: 'Section',
      total_spots: 1,
      price: 200,
    });
    const spot = section.spots.values()[0];
    section.markSpotAsReserved(spot.id);

    expect(() => section.markSpotAsAvailable(new EventSpotId())).toThrow(
      'Spot not found',
    );

    expect(spot.is_reserved).toBe(true);
  });

  test('finds the owning section, releases only the target and registers the event', () => {
    const event = Event.create({
      name: 'Event',
      date: new Date(),
      partner_id: new PartnerId(),
    });
    event.addSection({ name: 'First', total_spots: 1, price: 100 });
    event.addSection({ name: 'Second', total_spots: 2, price: 200 });
    event.publishAll();
    const [first, second] = event.sections.values();
    const firstSpot = first.spots.values()[0];
    const [target, other] = second.spots.values();
    for (const [section, spot] of [
      [first, firstSpot],
      [second, target],
      [second, other],
    ] as const) {
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
    }
    const previousEvents = [...event.events];
    const spotId = new EventSpotId(target.id.value);

    event.markSpotAsAvailable(spotId);

    expect(target.is_reserved).toBe(false);
    expect(firstSpot.is_reserved).toBe(true);
    expect(other.is_reserved).toBe(true);
    expect(
      event.allowReserveSpot({ section_id: second.id, spot_id: target.id }),
    ).toBe(true);
    const events = [...event.events];
    expect(events.slice(0, -1)).toEqual(previousEvents);
    expect(events).toHaveLength(previousEvents.length + 1);
    const released = events[events.length - 1] as EventSpotReleased;
    expect(released).toBeInstanceOf(EventSpotReleased);
    expect(released.aggregate_id).toBe(event.id);
    expect(released.event_id).toBe(event.id);
    expect(released.section_id).toBe(second.id);
    expect(released.spot_id).toBe(spotId);
    event.markSpotAsReserved({ section_id: second.id, spot_id: target.id });
    expect(target.is_reserved).toBe(true);
  });

  test('rejects an unknown spot without changing reservations or events', () => {
    const event = Event.create({
      name: 'Event',
      date: new Date(),
      partner_id: new PartnerId(),
    });
    event.addSection({ name: 'Section', total_spots: 1, price: 200 });
    const section = event.sections.values()[0];
    const spot = section.spots.values()[0];
    event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
    const previousEvents = [...event.events];

    expect(() => event.markSpotAsAvailable(new EventSpotId())).toThrow(
      'Spot not found',
    );

    expect(spot.is_reserved).toBe(true);
    expect([...event.events]).toEqual(previousEvents);
  });
});