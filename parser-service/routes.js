/**
 * Routes.js orchestrates the calling of the various helper function when an
 * http service is invoked.
 */

const recommender = require('./recommender')
const terraform = require('./terraform')
const sourceControl = require('./sourcecontrol')
const github = require('./github')
const db = require('./db')

const BASE_REPO = process.env.GITHUB_ACCOUNT

/**
 * This function fetches recommendations from the Recommender API. It invokes
 * supporting methods to filter and parse these recommendations, download
 * supporting files, committing to Git, generating a pull request and updating
 * the Recommender API to mark recommendation status as Claimed.
 *
 * @param req is the request object
 * @param res is the response object
 */
const applyRecommendations = async (req, res) => {
  try {
    console.log('Parse Recommendation request received', req.body)
    const repoName = req.body.repo
    const projectIDs = req.body.projects
    const type = req.params.type.toUpperCase()
    //const isStub = req.body.stub ? true : false

    let listRecommendationsFn
    let applyRecommendationsFn

    switch (type) {
      case 'VM':
        listRecommendationsFn = recommender.listVMResizeRecommendations
        applyRecommendationsFn = terraform.applyVMResizeRecommendations
        break
      case 'IAM':
        listRecommendationsFn = recommender.listIAMRecommendations
        applyRecommendationsFn = terraform.applyIAMRecommendations
        break
      default:
        res.status(500).send('Unknown operation')
    }

    // Fetch Recommendation from Recommender
    const recommendations = await listRecommendationsFn(projectIDs)

    if (recommendations.length == 0) {
      res.end('Nothing to apply')
      return
    }

    // Download Source Repository
    await sourceControl.cloneRepository(
      `git@${BASE_REPO}/${repoName}.git`, repoName)

    const recommendationsToClaim = await applyRecommendationsFn(
      repoName, recommendations)

    if (recommendationsToClaim.length > 0) {
      // Push changes to git
      const commitMessage = type == 'VM' ?
        `Recommended VM Rightsizing as on ${(new Date()).toLocaleString()}` :
        `Recommended IAM Updates as on ${(new Date()).toLocaleString()}`

      const commit =
        await sourceControl.commitChanges(commitMessage, repoName)

      // Create pull request
      await github.createPullRequest(
        `git@${BASE_REPO}/${repoName}.git`, commit.branch, commitMessage)

      // Write commit to database
      await db.createCommit(repoName, commit.commit,
          recommendationsToClaim)

      // Claim recommendations
      //if (!isStub) {
        await recommender.setRecommendationStatus(
          recommendationsToClaim, 'markClaimed')
      //}
    }

    res.sendStatus(201).end()
  } catch(e) {
    console.error(e)
    res.sendStatus(500).end(e.toString())
  }
}

/**
 * This handles the route called by the Pub/Sub subscription after the Cloud
 * Build (CI / CD) job completes. If the job has run successfully, the
 * service updates the recommendations state by invoking the Recommender API.
 *
 * @param req is the request object
 * @param res is the response object
 */
const ci = async (req, res) => {
  const data = req.body.message.data
  const payload = JSON.parse(Buffer.from(data, 'base64').toString())

  try {
    if (payload.status == 'SUCCESS' && payload.substitutions) {
      const commitID = payload.substitutions.COMMIT_SHA
      const repoName = payload.substitutions.REPO_NAME
      const fullRepoName = `${BASE_REPO}/${repoName}`

      // Get parent commits
      console.log('/ci starting step Get Parent Commits')
      const parentCommits =
        await github.getParentCommits(fullRepoName, commitID)
      console.log('/ci end step Get Parent Commits',
        JSON.stringify(parentCommits))

      // Get Recommendation IDs from DB for each parent commit
      console.log('/ci starting step Get Recommendation IDs from DB')
      const dbLookUpPromises = parentCommits.map(c => db.getCommit(repoName, c))
      const dbLookUpPromisesResult =
        await Promise.all(dbLookUpPromises)

      // Flatten recommendations
      const recommendationIDs = dbLookUpPromisesResult.reduce((acc, result) => {
        return [...acc, ...result]
      }, [])

      console.log('/ci recommendationIDs are', recommendationIDs)

      // Get etags for recommendations
      console.log('/ci starting step Get etags for recommendation')
      const recommendationsResult =
        await recommender.getRecommendations(recommendationIDs)

      console.log('/ci recommendations are', recommendationsResult)

      const recommendations = recommendationsResult.map(reco => ({
        id: reco.name,
        etag: reco.etag
      }))

      // Mark Recommendations as succeeded
      console.log('/ci starting step Mark Recommendations as succeeded')
      await recommender.setRecommendationStatus(
        recommendations, 'markSucceeded')

      res.sendStatus(201)
    } else {
      res.sendStatus(200)
    }
  } catch (e) {
    console.log('ERROR: ', e.toString())
    res.status(500).send(e.toString())
  }
}

module.exports = {
  applyRecommendations,
  ci
}
