/**
 * Formats a timestamp into a human-readable "time ago" string.
 * For example: "just now", "5 minutes ago", "2 hours ago", "yesterday", "2 days ago", "3 weeks ago", etc.
 * 
 * @param {number} timestamp - The timestamp in milliseconds
 * @return {string} - A human-readable time difference
 */
function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  // Less than a minute
  if (seconds < 60) {
    return 'just now';
  }
  
  // Less than an hour
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  }
  
  // Less than a day
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  }
  
  // Less than a week
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  
  // Less than a month
  const weeks = Math.floor(days / 7);
  if (weeks < 4) {
    return weeks === 1 ? 'a week ago' : `${weeks} weeks ago`;
  }
  
  // Less than a year
  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? 'a month ago' : `${months} months ago`;
  }
  
  // A year or more
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

export { formatTimeAgo };
