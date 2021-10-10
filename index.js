require('dotenv').config()
const Redis = require('ioredis')
const cheerio = require('cheerio')
const line = require('@line/bot-sdk')
const { default: axios } = require('axios')
const bodyParser = require('body-parser')
const express = require('express')
const path = require('path')
const PORT = process.env.PORT || 5000

const lineClient = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
})
const redisClient = new Redis(process.env.REDIS_URL, {
  tls: {
    rejectUnauthorized: false,
  },
})

const app = express()
  .use(bodyParser.json())
  .use(express.static(path.join(__dirname, 'public')))
  .set('views', path.join(__dirname, 'views'))
  .set('view engine', 'ejs')

app
  .get('/', async (req, res) => {
    const teamIds = await getTeamIds()
    return res.send(`<ul>
    ${teamIds.map(teamId => `<li><a href="/teams/${teamId}">Team ${teamId}</li>`)}
    </ul>`)
  })
  .get('/teams/:teamId', async (req, res) => {
    const teamId = req.params.teamId
    const force = Boolean(Number(new URLSearchParams(req.query).get('force')))
    const articles = await fetchTeamArticles(teamId, force)
    for (let index = 0; index < articles.length; index++) {
      const article = articles[index]
      await redisClient.hset(`teams:${teamId}:articles:${article.id}`, article)
    }
    return res.send({ articles })
  })
  .post('/callback', async (req, res) => {
    try {
      for (let index = 0; index < req.body.events.length; index++) {
        const event = req.body.events[index]
        console.log({ event })
        if (event.type === 'message' && event.message.type === 'text' && event.message.text.startsWith('check')) {
          const teamId = Number(event.message.text.split(' ').pop())
          if (!teamId) {
            await lineClient.replyMessage(event.replyToken, {
              type: 'text',
              text: '抓不到 Team ID',
            })
          } else {
            const id =
              event.source.type === 'group'
                ? event.source.groupId
                : event.source.type === 'room'
                ? event.source.roomId
                : event.source.userId
            await redisClient.sadd(`teams:${teamId}:receivers`, id)
            try {
              const statusMessage = await getTeamStatusMessage(teamId)
              await lineClient.replyMessage(event.replyToken, statusMessage)
            } catch (error) {
              console.error(error.response.data)
              await lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: `Something went wrong...`,
              })
            }
          }
        }
      }
      return res
    } catch (error) {
      console.error(error)
      return res.send({ error })
    }
  })
  .listen(PORT, () => console.log(`Listening on ${PORT}`))

const fetchCurrentDay = async teamId => {
  const response = await axios.get(`https://ithelp.ithome.com.tw/2021ironman/signup/team/${teamId}`)
  const $ = cheerio.load(response.data)
  const day = Number($('.team-dashboard__day').text().trim()) + 1
  return day
}

const fetchTeamMembers = async teamId => {
  const response = await axios.get(`https://ithelp.ithome.com.tw/2021ironman/signup/team/${teamId}`)
  const $ = cheerio.load(response.data)
  const members = $('.team-leader-info__name')
    .map((idx, el) => $(el).text())
    .toArray()
  return members
}

const fetchTeamArticles = async (teamId, force = false, page = 1) => {
  console.log({ teamId, force, page })
  const response = await axios.get(`https://ithelp.ithome.com.tw/2021ironman/signup/team/${teamId}?page=${page}`)
  const $ = cheerio.load(response.data)
  const articles = $('.team-article .ir-list')
    .map((_, el) => {
      const articleLink = $(el).children('.ir-list__title').children('a').attr().href
      const articleId = articleLink.split('/').pop()
      const article = {
        id: articleId,
        author: $(el).children('.ir-list__info').children('.ir-list__user').children('span.ir-list__name').html(),
        title: $(el).children('.ir-list__title').children('a').html(),
        link: articleLink,
        day: Number(
          $(el)
            .children('.ir-list__group')
            .children('.ir-list__group-topic')
            .children('span.ir-list__group-topic-num')
            .html()
            .trim(),
        ),
      }
      return article
    })
    .toArray()
  if (articles.length === 0) {
    return articles
  }
  if (!force) {
    const cachedTeamArticleKeys = await redisClient.keys(`teams:${teamId}:articles:*`)
    let noNextPage = false
    for (let index = 0; index < cachedTeamArticleKeys.length; index++) {
      const cachedTeamArticleKey = cachedTeamArticleKeys[index]
      const cachedArticleId = cachedTeamArticleKey.split(':').pop()
      if (!articles.find(article => article.id === cachedArticleId)) {
        const cachedArticle = await redisClient.hgetall(cachedTeamArticleKey)
        articles.push(cachedArticle)
      } else {
        noNextPage = true
      }
    }
    if (noNextPage) {
      return articles
    }
  }
  const restArticles = await fetchTeamArticles(teamId, force, page + 1)
  restArticles.forEach(article => articles.push(article))
  return articles
}

const getTeamIds = async () => {
  const teamIds = []
  const teamKeys = await redisClient.keys('teams:*:receivers')
  teamKeys.forEach(teamKey => teamIds.push(Number(teamKey.split(':')[1])))
  return teamIds
}

const getTeamStatusMessage = async teamId => {
  const currentDay = await fetchCurrentDay(teamId)
  const members = await fetchTeamMembers(teamId)
  const articles = await fetchTeamArticles(teamId)
  const memberStatusList = members.map(member => {
    return {
      member,
      articles: articles.filter(article => article.author === member).length,
    }
  })
  const message = {
    type: 'text',
    text:
      `# ${currentDay}\n` +
      `-------------------\n` +
      memberStatusList.map(memberStatus => `${memberStatus.member}: ${memberStatus.articles}`).join('\n') +
      `\n\n團隊連結：\nhttps://ithelp.ithome.com.tw/2021ironman/signup/team/${teamId}`,
  }
  return message
}
