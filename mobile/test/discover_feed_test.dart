import 'package:flutter_test/flutter_test.dart';

import 'package:sylor/services/dm_service.dart';
import 'package:sylor/services/social_service.dart';

/// Pure-logic tests for the Discover "For you" ranking and the DM thread-id
/// helpers — no Firebase, no network.
void main() {
  FeedPost post(
    String id, {
    String uid = 'author',
    int likes = 0,
    int comments = 0,
    int shares = 0,
    int ageHours = 0,
  }) {
    return FeedPost(
      id: id,
      uid: uid,
      name: 'n',
      photo: '',
      text: 't $id',
      link: '',
      linkTitle: '',
      linkImage: '',
      linkSite: '',
      topics: const <String>[],
      likeCount: likes,
      commentCount: comments,
      shareCount: shares,
      createdAtMs: DateTime.fromMillisecondsSinceEpoch(0)
          .add(Duration(hours: 1000 - ageHours))
          .millisecondsSinceEpoch,
    );
  }

  group('SocialService.prioritizePosts', () {
    final now = DateTime.fromMillisecondsSinceEpoch(0)
        .add(const Duration(hours: 1000))
        .millisecondsSinceEpoch;

    test('engagement outranks recency when the gap is big', () {
      final fresh = post('fresh', ageHours: 0);
      final hot = post('hot', likes: 50, comments: 20, ageHours: 70);
      final out = SocialService.prioritizePosts(
        <FeedPost>[fresh, hot],
        seed: 1,
        nowMs: now,
      );
      expect(out.first.id, 'hot');
    });

    test('followed authors get a boost over equals', () {
      final a = post('a', ageHours: 5);
      final b = post('b', ageHours: 5, uid: 'friend');
      final out = SocialService.prioritizePosts(
        <FeedPost>[a, b],
        following: <String>{'friend'},
        seed: 2,
        nowMs: now,
      );
      expect(out.first.id, 'b');
    });

    test('same seed → same order (stable while scrolling)', () {
      final posts = <FeedPost>[
        for (var i = 0; i < 12; i++) post('p$i', likes: i, ageHours: i % 24),
      ];
      final one = SocialService.prioritizePosts(posts, seed: 7, nowMs: now);
      final two = SocialService.prioritizePosts(posts, seed: 7, nowMs: now);
      expect(one.map((p) => p.id).toList(), two.map((p) => p.id).toList());
    });

    test('new seed → different flow (pull-to-refresh re-shuffles)', () {
      final posts = <FeedPost>[
        for (var i = 0; i < 12; i++) post('p$i', likes: i, ageHours: i % 24),
      ];
      final one = SocialService.prioritizePosts(posts, seed: 1, nowMs: now);
      final two = SocialService.prioritizePosts(posts, seed: 2, nowMs: now);
      expect(one.map((p) => p.id).toList(), isNot(two.map((p) => p.id).toList()));
    });

    test('empty list stays empty and does not throw', () {
      expect(SocialService.prioritizePosts(<FeedPost>[], seed: 0), isEmpty);
    });
  });

  group('DmService.threadIdFor', () {
    test('is order-independent', () {
      expect(DmService.threadIdFor('aaa', 'bbb'), DmService.threadIdFor('bbb', 'aaa'));
    });

    test('joins sorted with a colon separator', () {
      expect(DmService.threadIdFor('bbb', 'aaa'), 'aaa:bbb');
    });

    test('membership is derivable from the id', () {
      final id = DmService.threadIdFor('user-two', 'user-one');
      expect(id.split(':'), containsAll(<String>['user-one', 'user-two']));
    });
  });

  group('presenceLine', () {
    test('online beats lastSeen', () {
      expect(presenceLine(const Presence(online: true, lastSeenMs: 0)), 'online');
    });

    test('stale presence reads as a last-seen line', () {
      final line = presenceLine(
        Presence(
          online: false,
          lastSeenMs: DateTime.now().millisecondsSinceEpoch - 5 * 60 * 1000,
        ),
      );
      expect(line, contains('last seen'));
    });

    test('null / never-seen reads as offline', () {
      expect(presenceLine(null), 'offline');
      expect(presenceLine(const Presence(online: false, lastSeenMs: 0)), 'offline');
    });
  });
}
