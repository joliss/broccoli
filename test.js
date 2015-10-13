try {
  throw new Error('x')
} finally {
  console.error('finally')
}