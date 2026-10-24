/**
 * The Linkie Hub's proxy calls (#577 moved these out of LinkiePage.jsx).
 *
 * One call each, named after the endpoint it reaches, so a path that does not
 * exist cannot hide behind a plausible function name the way `ltListLinks` did.
 * The paths themselves are `linkiePaths` in lib/linkie.js.
 */
import { postJSON } from '@/lib/api';
import { createPostsBody, linkiePaths } from '@/lib/linkie';

export const linkieFetch = (path, method = 'GET', body) =>
  postJSON('linkieProxy', { path, method, body });

export const ltGetProfiles = () => linkieFetch(linkiePaths.pages());
export const ltListPosts = (profileId) => linkieFetch(linkiePaths.posts(profileId));
export const ltCreatePost = (profileId, post) =>
  linkieFetch(linkiePaths.posts(profileId), 'POST', createPostsBody(post));
export const ltUpdatePostUrl = (profileId, postId, url) =>
  linkieFetch(linkiePaths.post(profileId, postId), 'PATCH', { url });
export const ltDeletePost = (profileId, postId) =>
  linkieFetch(linkiePaths.post(profileId, postId), 'DELETE');
export const ltGetTrafficStats = (pageId) => linkieFetch(linkiePaths.trafficStats(pageId));
