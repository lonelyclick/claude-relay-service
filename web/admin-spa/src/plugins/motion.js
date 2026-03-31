/**
 * @vueuse/motion 动画配置
 * 为页面元素添加流畅的进入/退出动画
 */

export const motionPresets = {
  // 淡入动画
  fadeIn: {
    initial: {
      opacity: 0
    },
    enter: {
      opacity: 1,
      transition: {
        duration: 300,
        ease: 'easeOut'
      }
    }
  },

  // 从下方滑入
  slideUp: {
    initial: {
      opacity: 0,
      y: 20
    },
    enter: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 400,
        ease: [0.4, 0, 0.2, 1]
      }
    }
  },

  // 从上方滑入
  slideDown: {
    initial: {
      opacity: 0,
      y: -20
    },
    enter: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 400,
        ease: [0.4, 0, 0.2, 1]
      }
    }
  },

  // 从左侧滑入
  slideLeft: {
    initial: {
      opacity: 0,
      x: 20
    },
    enter: {
      opacity: 1,
      x: 0,
      transition: {
        duration: 400,
        ease: [0.4, 0, 0.2, 1]
      }
    }
  },

  // 从右侧滑入
  slideRight: {
    initial: {
      opacity: 0,
      x: -20
    },
    enter: {
      opacity: 1,
      x: 0,
      transition: {
        duration: 400,
        ease: [0.4, 0, 0.2, 1]
      }
    }
  },

  // 缩放进入
  scaleIn: {
    initial: {
      opacity: 0,
      scale: 0.9
    },
    enter: {
      opacity: 1,
      scale: 1,
      transition: {
        duration: 400,
        ease: [0.34, 1.56, 0.64, 1]
      }
    }
  },

  // 卡片列表项（带延迟）
  cardItem: (index = 0) => ({
    initial: {
      opacity: 0,
      y: 20
    },
    enter: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 400,
        delay: index * 50,
        ease: [0.4, 0, 0.2, 1]
      }
    }
  }),

  // 统计卡片（弹性动画）
  statCard: (index = 0) => ({
    initial: {
      opacity: 0,
      scale: 0.95,
      y: 10
    },
    enter: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: {
        duration: 500,
        delay: index * 80,
        ease: [0.34, 1.56, 0.64, 1]
      }
    }
  })
}

export default motionPresets
